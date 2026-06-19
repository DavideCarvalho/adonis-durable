import { randomUUID } from 'node:crypto';
import type { Adapter, AdapterFactory, JobData } from '@adonisjs/queue/types';
import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  runStepHandler,
} from '@agora/durable-core';
import {
  type ControlPayload,
  type HeartbeatPayload,
  type ResultPayload,
  type TaskPayload,
  fromJson,
  toJson,
} from './serialization.js';

/** How often the engine-side / worker-side poll loops ask the adapter for the next job. */
const DEFAULT_POLL_INTERVAL_MS = 200;

export interface QueueTransportOptions {
  /**
   * Factory for the `@adonisjs/queue` adapter this transport reads/writes. The same kind of factory
   * you hand `@adonisjs/queue`'s `defineConfig` (e.g. `redis(...)`, `knex(...)`, or `FakeAdapter`).
   * One adapter instance is created per transport and reused for every queue.
   */
  adapter: AdapterFactory;
  /**
   * The worker group this instance serves. Required to register {@link QueueTransport.handle}
   * consumers — the task poll loop pulls from this group's task queue. Omit on an engine-only
   * instance that just dispatches + consumes results.
   */
  group?: string;
  /** Queue-name prefix so several apps can share one backend without colliding. Default `durable`. */
  prefix?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** Stable id for this process (stamped on heartbeats / control `from`). Default a random id. */
  instanceId?: string;
}

type Loop = { stop: () => void };

/**
 * A `@adonisjs/queue`-backed {@link Transport}. Remote steps are dispatched to a per-group task
 * queue; the worker side runs the registered handler via {@link runStepHandler} and pushes the
 * {@link StepResult} onto a results queue the engine consumes. Heartbeats ride their own queue.
 *
 * `@adonisjs/queue` v0.6 is a one-directional job queue (dispatch → a separate `Worker` process
 * runs `job.execute()`), with no built-in way to await a job's result. This transport instead
 * drives the underlying queue **adapter** directly (`pushOn` / `popFrom` / `completeJob`), so both
 * directions are plain point-to-point queues we fully control. See DESIGN.md for the trade-offs —
 * notably that the {@link ControlPlane} here is single-consumer (point-to-point), so it is correct
 * for a single engine instance but does NOT fan out to every pod the way a real pub/sub does.
 *
 * Run one instance engine-side (`onResult` + `dispatch`) and one per worker process (`handle()`).
 * The wire payloads are the documented `RemoteTask`/`StepResult` JSON, so non-Node workers on the
 * same queues interoperate.
 */
export class QueueTransport implements Transport, ControlPlane {
  readonly #adapter: Adapter;
  readonly #group: string | undefined;
  readonly #prefix: string;
  readonly #pollIntervalMs: number;
  readonly #instanceId: string;
  readonly #handlers = new Map<string, StepHandler>();
  readonly #loops = new Set<Loop>();
  #taskLoop: Loop | undefined;
  #closed = false;

  constructor(options: QueueTransportOptions) {
    this.#adapter = options.adapter();
    this.#group = options.group;
    this.#prefix = options.prefix ?? 'durable';
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#instanceId = options.instanceId ?? randomUUID();
    // pop()/popFrom() require a worker id be set on the adapter before consuming.
    this.#adapter.setWorkerId(this.#instanceId);
  }

  /** Stable id stamped on heartbeats and control `from`. */
  get instanceId(): string {
    return this.#instanceId;
  }

  #tasksQueue(group: string): string {
    return `${this.#prefix}:tasks:${group}`;
  }
  #resultsQueue(): string {
    return `${this.#prefix}:results`;
  }
  #heartbeatsQueue(): string {
    return `${this.#prefix}:heartbeats`;
  }
  #controlQueue(): string {
    return `${this.#prefix}:control`;
  }

  /** Build the adapter `JobData` envelope for a JSON-safe payload. */
  #job(name: string, payload: unknown): JobData {
    return { id: randomUUID(), name, payload: toJson(payload), attempts: 0, createdAt: Date.now() };
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  async dispatch(task: RemoteTask): Promise<void> {
    await this.#adapter.pushOn(this.#tasksQueue(task.group), this.#job('task', task));
  }

  // ---------------------------------------------------------------------------
  // worker side — register a step handler, run it, push the result back
  // ---------------------------------------------------------------------------

  /**
   * Register a step handler (worker side). Starts this group's task poll loop on the first call —
   * each task it pops runs through {@link runStepHandler} and its result is pushed to the engine.
   */
  handle(name: string, fn: StepHandler): void {
    if (!this.#group) {
      throw new Error('QueueTransport needs a `group` option to register handlers');
    }
    this.#handlers.set(name, fn);
    if (!this.#taskLoop) {
      const group = this.#group;
      this.#taskLoop = this.#startLoop(this.#tasksQueue(group), async (job) => {
        const task = fromJson<TaskPayload>(job.payload);
        const result = await runStepHandler(task, this.#handlers.get(task.name));
        await this.#adapter.pushOn(this.#resultsQueue(), this.#job('result', result));
      });
    }
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step. */
  async heartbeat(beat: Heartbeat): Promise<void> {
    await this.#adapter.pushOn(this.#heartbeatsQueue(), this.#job('heartbeat', beat));
  }

  // ---------------------------------------------------------------------------
  // worker → engine — the engine consumes results + heartbeats
  // ---------------------------------------------------------------------------

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#startLoop(this.#resultsQueue(), async (job) => {
      await handler(fromJson<ResultPayload>(job.payload));
    });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#startLoop(this.#heartbeatsQueue(), async (job) => {
      await handler(fromJson<HeartbeatPayload>(job.payload));
    });
  }

  // ---------------------------------------------------------------------------
  // control plane (best-effort, point-to-point — see DESIGN.md)
  // ---------------------------------------------------------------------------

  async publishControl(msg: ControlMessage): Promise<void> {
    const stamped: ControlMessage = msg.from ? msg : { ...msg, from: this.#instanceId };
    await this.#adapter.pushOn(this.#controlQueue(), this.#job('control', stamped));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.#startLoop(this.#controlQueue(), async (job) => {
      handler(fromJson<ControlPayload>(job.payload));
    });
  }

  // ---------------------------------------------------------------------------
  // poll loop
  // ---------------------------------------------------------------------------

  /**
   * Poll `queue` on an interval, handing each popped job to `onJob`, then marking it complete. A
   * throwing `onJob` fails the job (so it is not silently lost) and the loop keeps running. Returns
   * a handle that stops the loop; also tracked so {@link close} stops them all.
   */
  #startLoop(queue: string, onJob: (job: JobData) => Promise<void>): Loop {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (stopped || this.#closed) return;
      try {
        // Drain everything currently available before sleeping, so a burst is processed promptly.
        let job = await this.#adapter.popFrom(queue);
        while (job && !stopped && !this.#closed) {
          try {
            await onJob(job);
            await this.#adapter.completeJob(job.id, queue);
          } catch (err) {
            await this.#adapter
              .failJob(job.id, queue, err instanceof Error ? err : new Error(String(err)))
              .catch(() => {});
          }
          job = await this.#adapter.popFrom(queue);
        }
      } catch {
        // A transient adapter error: swallow and retry on the next tick.
      }
      if (!stopped && !this.#closed) {
        timer = setTimeout(() => void tick(), this.#pollIntervalMs);
        timer.unref?.();
      }
    };

    const loop: Loop = {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        this.#loops.delete(loop);
      },
    };
    this.#loops.add(loop);
    void tick();
    return loop;
  }

  /** Stop every poll loop and destroy the adapter so the process can exit. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const loop of this.#loops) loop.stop();
    this.#loops.clear();
    this.#taskLoop = undefined;
    await this.#adapter.destroy();
  }
}
