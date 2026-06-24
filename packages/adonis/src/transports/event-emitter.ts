import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepResult,
  type Transport,
} from '../interfaces.js';
import { type StepHandler, runStepHandler } from '../protocol.js';

/** Event names the transport multiplexes over a single in-process emitter. */
export const TASK_EVENT = 'durable.task';
export const RESULT_EVENT = 'durable.result';
export const HEARTBEAT_EVENT = 'durable.heartbeat';
export const CONTROL_EVENT = 'durable.control';

export interface EventEmitterTransportOptions {
  /**
   * The in-process emitter to multiplex over. Defaults to a fresh Node `EventEmitter` (listener cap
   * lifted, since the engine wires several long-lived listeners). Pass `@adonisjs/core`'s `emitter`
   * service if you'd rather ride the app's bus — it is API-compatible for `on`/`emit`.
   */
  emitter?: EventEmitter;
  /**
   * The worker group this instance serves. Unused for routing (handlers are matched by step name in
   * this same process) — accepted for parity with the broker transports, and stamped nowhere.
   */
  group?: string;
  /** Stable id for this process (stamped on control `from` when a publisher leaves it unset). Default random. */
  instanceId?: string;
}

/** The minimal `on`/`emit` surface this transport needs — satisfied by Node's `EventEmitter` and
 *  `@adonisjs/core`'s emitter alike, so neither is a hard dependency. */
type EmitterLike = Pick<EventEmitter, 'on' | 'emit'>;

/**
 * A production **in-process** {@link Transport} (and {@link ControlPlane}) backed by a single Node
 * `EventEmitter`. Zero external infrastructure (no DB, no Redis, no broker): step handlers run in the
 * same process, fully decoupled from the workflow that dispatched them, so a single-process app runs
 * real durable workflows with nothing else to deploy.
 *
 * Distinct from the test-only {@link import('../testing/in-memory-transport.js').InMemoryTransport}:
 * that one drives `dispatch` straight into the handler (synchronous-ish, for deterministic tests);
 * this one decouples both directions through the emitter's event loop, mirroring how a real broker
 * fans dispatch → worker → result back. Both funnel every step through {@link runStepHandler}, so the
 * scoped context restore (the `@agora/context:scope` slot) works identically here.
 *
 * Swap to {@link import('./db.js').DbTransport} / {@link import('./queue.js').QueueTransport} for
 * true cross-process or cross-language steps. The {@link ControlPlane} here broadcasts locally (every
 * subscriber in this process), correct for single-instance; it does NOT fan out across pods.
 *
 * Usually you don't construct this directly: `config/durable.ts` selects it via
 * `transports.eventEmitter()` (alias `transports.memory()` from the factory points at the test
 * transport) and the provider builds it for you.
 */
export class EventEmitterTransport implements Transport, ControlPlane {
  readonly #emitter: EmitterLike;
  readonly #instanceId: string;
  readonly #handlers = new Map<string, StepHandler>();

  constructor(options: EventEmitterTransportOptions = {}) {
    // A long-lived single emitter carries several engine listeners; lift Node's default cap so the
    // engine wiring (result + heartbeat + control + task) never trips a MaxListenersExceededWarning.
    const emitter = options.emitter ?? new EventEmitter();
    if (emitter instanceof EventEmitter) emitter.setMaxListeners(0);
    this.#emitter = emitter;
    this.#instanceId = options.instanceId ?? randomUUID();
    // The worker side listens for every dispatched task and runs it if it owns the step name.
    this.#emitter.on(TASK_EVENT, (task: RemoteTask) => {
      void this.#process(task);
    });
  }

  /** Stable id stamped on control `from` when a publisher leaves it unset. */
  get instanceId(): string {
    return this.#instanceId;
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  async dispatch(task: RemoteTask): Promise<void> {
    this.#emitter.emit(TASK_EVENT, task);
  }

  // ---------------------------------------------------------------------------
  // worker side — register a step handler, run it, emit the result back
  // ---------------------------------------------------------------------------

  /** Register a step handler by name (the worker side, in this same process). */
  handle(name: string, fn: StepHandler): void {
    this.#handlers.set(name, fn);
  }

  /** Worker side: a liveness heartbeat. In-process handlers run synchronously, so emit it straight
   *  through for symmetry — an engine that wired `onHeartbeat` still observes it. */
  async heartbeat(beat: Heartbeat): Promise<void> {
    this.#emitter.emit(HEARTBEAT_EVENT, beat);
  }

  async #process(task: RemoteTask): Promise<void> {
    const handler = this.#handlers.get(task.name);
    // Another subscriber may own this step name — stay silent, don't synthesize a "no handler" failure.
    if (!handler) return;
    const result = await runStepHandler(task, handler);
    // Emit the result on a LATER tick: a durable `ctx.call` suspends the run right after dispatch, so
    // the result must land AFTER that unwinds (else the resume re-enters mid-suspend). Real brokers
    // deliver asynchronously; this mirrors them.
    setImmediate(() => this.#emitter.emit(RESULT_EVENT, result));
  }

  // ---------------------------------------------------------------------------
  // worker → engine — the engine consumes results + heartbeats
  // ---------------------------------------------------------------------------

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#emitter.on(RESULT_EVENT, (result: StepResult) => {
      void handler(result);
    });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#emitter.on(HEARTBEAT_EVENT, (beat: Heartbeat) => {
      void handler(beat);
    });
  }

  // ---------------------------------------------------------------------------
  // control plane (broadcast within this process)
  // ---------------------------------------------------------------------------

  async publishControl(msg: ControlMessage): Promise<void> {
    const stamped: ControlMessage = msg.from ? msg : { ...msg, from: this.#instanceId };
    this.#emitter.emit(CONTROL_EVENT, stamped);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.#emitter.on(CONTROL_EVENT, (msg: ControlMessage) => handler(msg));
  }
}
