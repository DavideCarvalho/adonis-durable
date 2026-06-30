import { randomUUID } from 'node:crypto';
import type { AcquiredJob, Adapter, AdapterFactory, JobData } from '@adonisjs/queue/types';
import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepResult,
  type Transport,
} from '../interfaces.js';
import { type PollLoop, Pollers } from '../pollers.js';
import { type StepHandler, runStepHandler } from '../protocol.js';

/**
 * The wire payloads carried as a queue job's `payload`. Everything that crosses the queue is plain
 * JSON — a `RemoteTask` (engine → worker), a `StepResult` / `Heartbeat` (worker → engine) and a
 * `ControlMessage` (best-effort). The adapter stores `payload: any`, so these helpers round-trip
 * through `JSON.stringify`/`JSON.parse` to guarantee that only JSON-safe values survive (functions,
 * symbols, `undefined` members are dropped exactly as a real broker would drop them).
 */

/** Serialize a value to a JSON-safe clone. Throws on a non-serializable value (e.g. a cycle). */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Parse a job payload that we previously wrote with {@link toJson}. */
export function fromJson<T>(value: unknown): T {
  // The adapter already gives us a structured value; if a driver hands back a raw string
  // (some persist `payload` as text), decode it. Otherwise pass it straight through.
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export type TaskPayload = RemoteTask;
export type ResultPayload = StepResult;
export type HeartbeatPayload = Heartbeat;
export type ControlPayload = ControlMessage;

/** How often the engine-side / worker-side poll loops ask the adapter for the next job. */
const DEFAULT_POLL_INTERVAL_MS = 200;

// `@adonisjs/queue` job priority is the INVERSE of the durable engine's: a queue job runs the LOWEST
// number first (1..10, default 5), while the engine's admission `priority` is "higher wins". We map
// so one convention ("higher = more urgent") holds end-to-end. `BASELINE - p` keeps relative order (a
// higher `p` yields a lower — more urgent — broker number), clamped into the adapter's valid range.
// Centred on the default so callers have headroom both above and below it.
const BROKER_PRIORITY_MIN = 1;
const BROKER_PRIORITY_MAX = 10;
const BROKER_PRIORITY_BASELINE = 5;

/**
 * Map the engine's per-call `priority` (higher = more urgent, default/absent = unprioritised) onto an
 * `@adonisjs/queue` job `priority` (lower = more urgent). Returns `undefined` for an absent priority so
 * the default FIFO path is untouched.
 */
export function toBrokerPriority(priority?: number): number | undefined {
  if (priority == null) return undefined;
  const mapped = Math.round(BROKER_PRIORITY_BASELINE - priority);
  return Math.min(BROKER_PRIORITY_MAX, Math.max(BROKER_PRIORITY_MIN, mapped));
}

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
  /**
   * Logical deployment namespace, folded into every queue name so the same backend can host several
   * worker-pool partitions without their tasks/results crossing. `"default"` (and absent) keeps queue
   * names BYTE-IDENTICAL to the un-namespaced scheme (production is unchanged); any other value
   * inserts a `-<namespace>` segment after the prefix. Passing it here is EXPLICIT and wins over a
   * later {@link QueueTransport.useNamespace} (the engine's propagation).
   */
  namespace?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** Stable id for this process (stamped on heartbeats / control `from`). Default a random id. */
  instanceId?: string;
}

/**
 * A `@adonisjs/queue`-backed {@link Transport}. Remote steps are dispatched to a per-group task
 * queue; the worker side runs the registered handler via {@link runStepHandler} and pushes the
 * {@link StepResult} onto a results queue the engine consumes. Heartbeats ride their own queue.
 *
 * `@adonisjs/queue` v0.6 is a one-directional job queue (dispatch → a separate `Worker` process
 * runs `job.execute()`), with no built-in way to await a job's result. This transport instead
 * drives the underlying queue **adapter** directly (`pushOn` / `popFrom` / `completeJob`), so both
 * directions are plain point-to-point queues we fully control. Notably the {@link ControlPlane} here
 * is single-consumer (point-to-point), so it is correct for a single engine instance but does NOT
 * fan out to every pod the way a real pub/sub does.
 *
 * Run one instance engine-side (`onResult` + `dispatch`) and one per worker process (`handle()`).
 * The wire payloads are the documented `RemoteTask`/`StepResult` JSON, so non-Node workers on the
 * same queues interoperate.
 *
 * Usually you don't construct this directly: `config/durable.ts` selects it via
 * `transports.queue({ ... })` and the provider builds it for you.
 */
export class QueueTransport implements Transport, ControlPlane {
  readonly #adapter: Adapter;
  readonly #group: string | undefined;
  readonly #prefix: string;
  // Logical deployment namespace folded into every queue name via `#effectivePrefix()`. Mutable so an
  // engine can push its namespace onto a transport via `useNamespace()` — but only when one wasn't
  // passed explicitly to the constructor (`#explicitNamespace`), which always wins.
  #namespace: string | undefined;
  readonly #explicitNamespace: boolean;
  readonly #pollIntervalMs: number;
  readonly #instanceId: string;
  readonly #handlers = new Map<string, StepHandler>();
  readonly #pollers: Pollers;
  #taskLoop: PollLoop | undefined;

  constructor(options: QueueTransportOptions) {
    this.#adapter = options.adapter();
    this.#group = options.group;
    this.#prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#instanceId = options.instanceId ?? randomUUID();
    // pop()/popFrom() require a worker id be set on the adapter before consuming.
    this.#adapter.setWorkerId(this.#instanceId);
    this.#pollers = new Pollers(this.#pollIntervalMs);
  }

  /** Stable id stamped on heartbeats and control `from`. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /**
   * Adopt `namespace` (the engine's, typically), folding it into every queue name — but ONLY if a
   * namespace wasn't passed explicitly to the constructor (an explicit one always wins). Idempotent.
   * Satisfies the optional `Transport.useNamespace` hook the engine calls when wiring a transport.
   */
  useNamespace(namespace: string): void {
    if (this.#explicitNamespace) return;
    this.#namespace = namespace;
  }

  /**
   * The prefix every queue name is built from, folding in the namespace: a set, non-`"default"`
   * namespace appends `-<namespace>`; otherwise the bare prefix (so the un-namespaced and `"default"`
   * schemes are byte-identical — production names never change). Keep ALL name builders routed through
   * this; a single direct `this.#prefix` would split an engine from its workers.
   */
  #effectivePrefix(): string {
    return this.#namespace && this.#namespace !== 'default'
      ? `${this.#prefix}-${this.#namespace}`
      : this.#prefix;
  }

  #tasksQueue(group: string): string {
    return `${this.#effectivePrefix()}:tasks:${group}`;
  }
  #resultsQueue(): string {
    return `${this.#effectivePrefix()}:results`;
  }
  #heartbeatsQueue(): string {
    return `${this.#effectivePrefix()}:heartbeats`;
  }
  #controlQueue(): string {
    return `${this.#effectivePrefix()}:control`;
  }

  /**
   * Build the adapter `JobData` envelope for a JSON-safe payload. A translated `priority` is added
   * only when set, so the default FIFO path is untouched for unprioritised dispatches.
   */
  #job(name: string, payload: unknown, priority?: number): JobData {
    const brokerPriority = toBrokerPriority(priority);
    return {
      id: randomUUID(),
      name,
      payload: toJson(payload),
      attempts: 0,
      createdAt: Date.now(),
      ...(brokerPriority != null ? { priority: brokerPriority } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  async dispatch(task: RemoteTask): Promise<void> {
    await this.#adapter.pushOn(
      this.#tasksQueue(task.group),
      this.#job('task', task, task.priority),
    );
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
  // control plane (best-effort, point-to-point)
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
   * Poll `queue`, handing each popped job to `onJob` then marking it complete. A throwing `onJob`
   * fails the job (so it is not silently lost) and polling continues. One job is popped per tick;
   * core's {@link Pollers} drains a burst (re-ticking while a job was found) before sleeping, and
   * owns the stop-all bookkeeping. Returns a handle that stops just this loop.
   */
  #startLoop(queue: string, onJob: (job: JobData) => Promise<void>): PollLoop {
    return this.#pollers.start(async () => {
      let job: AcquiredJob | null;
      try {
        job = await this.#adapter.popFrom(queue);
      } catch {
        // A transient adapter error: treat as "no work", retry on the next tick.
        return false;
      }
      if (!job) return false;
      try {
        await onJob(job);
        await this.#adapter.completeJob(job.id, queue);
      } catch (err) {
        await this.#adapter
          .failJob(job.id, queue, err instanceof Error ? err : new Error(String(err)))
          .catch(() => {});
      }
      return true;
    });
  }

  /** Stop every poll loop and destroy the adapter so the process can exit. */
  async close(): Promise<void> {
    this.#pollers.stopAll();
    this.#taskLoop = undefined;
    await this.#adapter.destroy();
  }
}
