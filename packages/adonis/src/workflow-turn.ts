import type {
  HistoryEvent,
  StepError,
  WorkflowCommand,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from './interfaces.js';

/**
 * The shared, PURE "run one workflow turn" body — the TypeScript twin of the Python
 * `durable_worker/workflow.py` (`WorkflowContext` + `process_workflow_task`). Given a {@link WorkflowTask}
 * (a workflow name + input + the run's resolved `history`) it REPLAYS the registered body
 * deterministically and produces a {@link WorkflowDecision} (dispatch steps / sleep / wait-signal /
 * start-child / complete / fail / suspend). It owns NO store and does NO I/O beyond the body itself, so
 * BOTH a store-less worker (the {@link import('./worker-runtime/worker-runtime.js').WorkerRuntime}
 * consuming `workflow` jobs off `${P}-tasks-<token>`) AND the engine (via
 * {@link import('./remote-workflow-executor.js').LocalWorkflowTurnExecutor}) drive a TS workflow turn
 * through the exact same code — the same way the engine's `RemoteWorkflowExecutor` drives a Python
 * worker's turn. It is Lucid-free (imports only interface TYPES), so it rides the lean `/worker` subpath.
 *
 * The wire it emits is byte-compatible with aviary: every `ctx.*` op is keyed by a deterministic `seq`;
 * an op already resolved in `history` returns its recorded value (never re-run), and the FIRST
 * unresolved blocking op (step/sleep/waitSignal/startChild) suspends the turn, emitting its command.
 * `ctx.now()`/`ctx.sideEffect()` run inline and record their result once (a `recordStep` local step) so
 * a non-deterministic capture happens exactly once and replays the same value.
 */

/** A step/call/child the workflow awaited resolved to a FAILURE. Thrown by the replaying op so a
 *  workflow body can `try/catch` it (compensate, or let it propagate to fail the run) — the TS twin of
 *  the Python `StepFailed`. Carries the structured {@link StepError} the engine recorded. */
export class WorkflowStepFailedError extends Error {
  readonly error: StepError;
  constructor(error: StepError | undefined) {
    super(error?.message ?? 'step failed');
    this.name = 'WorkflowStepFailedError';
    this.error = error ?? { message: 'step failed' };
  }
}

/** The history at `seq` did not match what the replay produced there — the workflow code changed under
 *  an in-flight run. The run fails loudly rather than silently diverging (Python `NondeterminismError`). */
export class WorkflowNondeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowNondeterminismError';
  }
}

/** A cooperative cancellation raised at an op boundary when the run was cancelled mid-turn — the turn
 *  bails with a `cancelled` decision (Python `Cancelled`). */
export class WorkflowTurnCancelled extends Error {
  constructor(readonly runId: string) {
    super(`workflow run ${runId} cancelled`);
    this.name = 'WorkflowTurnCancelled';
  }
}

/** Internal: stop the replay at the first unresolved blocking op (Python `_Suspend`). Never escapes. */
class TurnSuspend extends Error {}

/** Convert an arbitrary thrown value into the wire {@link StepError} (message + optional code + stack). */
function toStepError(err: unknown): StepError {
  const e = err as { message?: string; code?: string; stack?: string };
  const out: StepError = { message: err instanceof Error ? err.message : String(err) };
  if (typeof e?.code === 'string') out.code = e.code;
  if (err instanceof Error && typeof e.stack === 'string') out.stack = e.stack;
  return out;
}

/**
 * The replay context handed to a worker-side workflow body. Deterministic: same code + same history ⇒
 * same seqs ⇒ same decisions. Every method is SYNCHRONOUS — an op either returns its replayed value or
 * throws {@link TurnSuspend} to end the turn — so a body reads as ordinary straight-line code (mirrors
 * the Python `WorkflowContext`; the worker-side twin of the store-backed {@link import('./interfaces.js').WorkflowCtx}).
 */
export interface WorkflowTurnCtx {
  /** The run being advanced (the id the engine minted), or `undefined` for a bare test context. */
  readonly runId: string | undefined;
  /**
   * Dispatch a step (routed by handler `name`) and await its result — ALWAYS durable, engine-scheduled.
   * On replay returns the recorded output; the first turn that reaches it emits a `call` command and
   * suspends. `group` is the isolation PARTITION suffix (defaults to the workflow's own partition), NOT
   * a base queue — the engine composes the dispatch queue as `tenantGroup(sanitize(name), group)`.
   */
  step(name: string, input?: unknown, opts?: { group?: string }): unknown;
  /** Durably sleep `ms`; the run suspends and the engine resumes it when the timer fires. */
  sleep(ms: number): void;
  /** Block until a signal `name` is delivered to this run; returns its payload. */
  waitSignal(name: string): unknown;
  /** Start a child run and await its output (its own durable lifecycle). */
  startChild(workflow: string, input?: unknown): unknown;
  /** A replay-stable wall-clock timestamp in epoch ms — captured once, replayed thereafter. */
  now(): number;
  /** Run `fn` ONCE, record its result, and on replay return the same value WITHOUT re-running `fn` —
   *  the general deterministic-capture primitive (Temporal's `sideEffect`). `fn` MUST be synchronous. */
  sideEffect<T>(fn: () => T): T;
}

/** A worker-side workflow body: `(ctx, input) => output`. Written as straight-line code against the
 *  {@link WorkflowTurnCtx}; the engine replays it one turn at a time. May be sync or return a promise. */
export type WorkflowBody = (ctx: WorkflowTurnCtx, input: unknown) => unknown | Promise<unknown>;

/** How registered workflow bodies are looked up by name — a `Map` or a bare resolver function. */
export type WorkflowBodyResolver =
  | ReadonlyMap<string, WorkflowBody>
  | ((name: string) => WorkflowBody | undefined);

/** The worker-side workflow consumer a transport drives: given a {@link WorkflowTask} off
 *  `${P}-tasks-<token>`, produce the {@link WorkflowDecision} to publish on `${P}-decisions`. The
 *  {@link import('./worker-runtime/worker-runtime.js').WorkerRuntime} hands one to the transport per
 *  registered workflow name; it runs the turn through {@link runWorkflowTurn}. */
export type WorkflowTurnHandler = (task: WorkflowTask) => Promise<WorkflowDecision>;

/** Optional hooks for {@link runWorkflowTurn}. */
export interface RunWorkflowTurnOptions {
  /** Streams each local step's lifecycle (running → completed/failed) AS IT HAPPENS, so a long inline
   *  turn's steps show up live instead of only in the final decision. Best-effort — a throwing sink
   *  never fails the turn (mirrors the Python `on_step`). */
  onStep?: (event: WorkflowStepEvent) => void;
  /** Lets the replay bail at an op boundary when the run was cancelled mid-turn (→ `cancelled`
   *  decision). Called with the run id at every durable op (Python `is_cancelled`). */
  isCancelled?: (runId: string) => boolean;
  /** The worker's own partition — a `ctx.step` with no explicit `group` inherits it, so a workflow and
   *  its steps share the same isolation suffix (Python threads this in as the worker's `group`). */
  partition?: string | undefined;
  /** Clock for `ctx.now()`/`ctx.sideEffect` timing (injectable for a deterministic test). Default `Date.now`. */
  now?: () => number;
}

function resolveBody(resolver: WorkflowBodyResolver, name: string): WorkflowBody | undefined {
  return typeof resolver === 'function' ? resolver(name) : resolver.get(name);
}

class TurnContext implements WorkflowTurnCtx {
  readonly commands: WorkflowCommand[] = [];
  readonly #history: Map<number, HistoryEvent>;
  readonly #signalsBySeq: Map<number, { seq: number; signal: string; payload: unknown }>;
  readonly #partition: string | undefined;
  readonly #onStep: RunWorkflowTurnOptions['onStep'];
  readonly #isCancelled: RunWorkflowTurnOptions['isCancelled'];
  readonly #now: () => number;
  #seq = 0;

  constructor(
    readonly runId: string | undefined,
    history: HistoryEvent[],
    pendingSignals: WorkflowTask['pendingSignals'],
    opts: RunWorkflowTurnOptions,
  ) {
    this.#history = new Map(history.map((e) => [e.seq, e]));
    this.#signalsBySeq = new Map((pendingSignals ?? []).map((s) => [s.seq, s]));
    this.#partition = opts.partition;
    this.#onStep = opts.onStep;
    this.#isCancelled = opts.isCancelled;
    this.#now = opts.now ?? Date.now;
  }

  /** Every durable op takes its seq from here — the single choke point where between-op cancellation
   *  is enforced for the whole workflow API. */
  #next(): number {
    if (this.#isCancelled && this.runId !== undefined && this.#isCancelled(this.runId)) {
      throw new WorkflowTurnCancelled(this.runId);
    }
    return this.#seq++;
  }

  /** The raw history entry at `seq` (or undefined), enforcing the kind/name nondeterminism guard. */
  #replayEntry(seq: number, kind: HistoryEvent['kind'], name?: string): HistoryEvent | undefined {
    const ev = this.#history.get(seq);
    if (ev === undefined) return undefined;
    const nameMismatch = name !== undefined && ev.name !== undefined && ev.name !== name;
    if (ev.kind !== kind || nameMismatch) {
      throw new WorkflowNondeterminismError(
        `history at seq ${seq} is ${ev.kind}/${String(ev.name)}, but replay reached ${kind}/${String(name)}`,
      );
    }
    return ev;
  }

  /** `[found, output]` for a resolved op in history; throws on a recorded failure (a catchable
   *  {@link WorkflowStepFailedError}) so awaited failures surface exactly like a rejected await. */
  #replay(seq: number, kind: HistoryEvent['kind'], name?: string): [boolean, unknown] {
    const ev = this.#replayEntry(seq, kind, name);
    if (ev === undefined) return [false, undefined];
    if (ev.error != null) throw new WorkflowStepFailedError(ev.error);
    return [true, ev.output];
  }

  #emitStep(event: WorkflowStepEvent): void {
    if (!this.#onStep) return;
    try {
      this.#onStep(event);
    } catch {
      /* live-tail is best-effort observability — a broken sink must never fail the workflow */
    }
  }

  step(name: string, input: unknown = undefined, opts: { group?: string } = {}): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'call', name);
    if (found) return output;
    const group = opts.group ?? this.#partition ?? '';
    this.commands.push({ kind: 'call', seq, name, group, input });
    throw new TurnSuspend();
  }

  sleep(ms: number): void {
    const seq = this.#next();
    const [found] = this.#replay(seq, 'timer');
    if (found) return;
    this.commands.push({ kind: 'sleep', seq, ms });
    throw new TurnSuspend();
  }

  waitSignal(name: string): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'signal', name);
    if (found) return output;
    const sig = this.#signalsBySeq.get(seq);
    if (sig !== undefined) return sig.payload;
    this.commands.push({ kind: 'waitSignal', seq, signal: name });
    throw new TurnSuspend();
  }

  startChild(workflow: string, input: unknown = undefined): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'child', workflow);
    if (found) return output;
    this.commands.push({ kind: 'startChild', seq, workflow, input });
    throw new TurnSuspend();
  }

  now(): number {
    // The seq _localStep's own #next() is about to allocate — mirror the Python `now#<seq>` name.
    return this.#localStep(`now#${this.#seq}`, () => this.#now()) as number;
  }

  sideEffect<T>(fn: () => T): T {
    return this.#localStep('sideEffect', fn) as T;
  }

  /** Run a LOCAL step once and record its result (a `recordStep` command), so a captured value happens
   *  exactly once and replay returns it. Backs {@link now} and {@link sideEffect}. */
  #localStep(name: string, body: () => unknown): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'step', name);
    if (found) return output;

    const startedAt = this.#now();
    this.#emitStep({ runId: this.runId ?? '', seq, name, phase: 'running', startedAt });
    let result: unknown;
    try {
      result = body();
    } catch (err) {
      const error = toStepError(err);
      const finishedAt = this.#now();
      this.commands.push({ kind: 'recordStep', seq, name, error, startedAt, finishedAt });
      this.#emitStep({ runId: this.runId ?? '', seq, name, phase: 'failed', startedAt, finishedAt, error });
      throw new WorkflowStepFailedError(error);
    }
    const finishedAt = this.#now();
    this.commands.push({ kind: 'recordStep', seq, name, output: result, startedAt, finishedAt });
    this.#emitStep({
      runId: this.runId ?? '',
      seq,
      name,
      phase: 'completed',
      startedAt,
      finishedAt,
      output: result,
    });
    return result;
  }
}

/**
 * Replay one turn of `task`'s workflow against the registered `bodies` and return the wire
 * {@link WorkflowDecision}. The shared core behind the store-less worker's workflow path AND the
 * engine's in-process {@link import('./remote-workflow-executor.js').LocalWorkflowTurnExecutor} —
 * transport-free and store-free, so it is testable with a plain task object.
 *
 * Outcomes (byte-compatible with aviary / the Python `process_workflow_task`):
 * - body returns → `completed` (with `output` + any `recordStep` commands run this turn);
 * - {@link TurnSuspend} (first unresolved blocking op) → `continue` (with the blocking `commands`);
 * - {@link WorkflowTurnCancelled} → `cancelled` (partial `commands` that DID run this turn);
 * - {@link WorkflowStepFailedError} → `failed` with that step's error;
 * - any other throw → `failed` with the converted error;
 * - no registered body → `failed` `{ code: 'no_workflow' }`.
 */
export async function runWorkflowTurn(
  bodies: WorkflowBodyResolver,
  task: WorkflowTask,
  opts: RunWorkflowTurnOptions = {},
): Promise<WorkflowDecision> {
  const base = { taskId: task.taskId, runId: task.runId };
  const body = resolveBody(bodies, task.workflow);
  if (body === undefined) {
    return {
      ...base,
      status: 'failed',
      commands: [],
      error: { message: `no workflow registered for '${task.workflow}'`, code: 'no_workflow' },
    };
  }
  const ctx = new TurnContext(task.runId, task.history, task.pendingSignals, opts);
  try {
    const output = await body(ctx, task.input);
    return { ...base, status: 'completed', commands: ctx.commands, output };
  } catch (err) {
    if (err instanceof TurnSuspend) {
      return { ...base, status: 'continue', commands: ctx.commands };
    }
    if (err instanceof WorkflowTurnCancelled) {
      return { ...base, status: 'cancelled', commands: ctx.commands };
    }
    if (err instanceof WorkflowStepFailedError) {
      return { ...base, status: 'failed', commands: ctx.commands, error: err.error };
    }
    return { ...base, status: 'failed', commands: ctx.commands, error: toStepError(err) };
  }
}

/**
 * True when `task` is a WORKFLOW turn (vs a step task) — discriminated BY SHAPE (spec §6.3), byte-for-
 * byte with the Python `is_workflow_task` (`runner-core.ts`): a workflow task carries a string
 * `workflow` name AND a `history` array. Both ride the SAME `${P}-tasks-<token>` queue, so a unified
 * consumer routes turns through the replay body and steps through `runStepHandler` on this predicate.
 */
export function isWorkflowTask(data: unknown): data is WorkflowTask {
  if (typeof data !== 'object' || data === null) return false;
  const t = data as Record<string, unknown>;
  return typeof t.workflow === 'string' && Array.isArray(t.history);
}
