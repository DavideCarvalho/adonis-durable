import { backoffDelay } from './backoff.js';
import { instantCheckpoint } from './checkpoints.js';
import { unwrapCompletion } from './completion.js';
import { parseDuration } from './duration.js';
import {
  ContinueAsNew,
  FatalError,
  NonDeterminismError,
  SignalTimeoutError,
  WorkflowSuspended,
} from './errors.js';
import { eventToken } from './events.js';
import type {
  ChildCallOptions,
  DurableWebhook,
  RemoteStepDef,
  StateStore,
  StepCheckpoint,
  StepError,
  StepEvent,
  StepInvocation,
  StepKind,
  StepLogger,
  StepOptions,
  WorkflowCtx,
} from './interfaces.js';
import { breakpointToken } from './protocol.js';
import { createStepLogger } from './step-logger.js';
import { type WorkflowRef, workflowName } from './workflow-ref.js';

/** Normalize the `ctx.child`/`ctx.startChild` 3rd arg: a bare string is shorthand for `{ childId }`. */
function normalizeChildOptions(options?: string | ChildCallOptions): ChildCallOptions {
  return typeof options === 'string' ? { childId: options } : (options ?? {});
}

/** A saga undo registered by a completed step, kept with its step name for visibility on failure. */
export interface Compensation {
  name: string;
  fn: () => Promise<void>;
}

/** A finished local step the host should checkpoint and announce (completed or failed). */
export interface StepRecord {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  input?: unknown;
  events?: StepEvent[] | undefined;
  attempts: number;
  enqueuedAt: Date;
  startedAt: Date;
  workerGroup?: string | undefined;
}

/**
 * The narrow surface {@link createWorkflowCtx} needs from the engine — the seam between the
 * authoring API (this module) and the orchestrator (the engine owns lifecycle: emitting events,
 * suspending/resuming runs, dispatching remote steps).
 */
export interface CtxHost {
  readonly store: StateStore;
  /**
   * Per-execution checkpoint snapshot, loaded ONCE at execution start (the completed prefix this
   * replay walks). Lets each primitive read the prefix from memory instead of a per-call DB SELECT
   * (the O(N²) replay-reads fix). A seq ABSENT from the map is NOT cached — the primitive falls back
   * to the live store, so the checkpoint this resume is waking on (signal/timer/child, written after
   * the snapshot) is always read fresh. New checkpoints written during this execution are inserted
   * into the map so any later same-execution read sees them. Undefined ⇒ always hit the store.
   */
  readonly replay?: Map<number, StepCheckpoint> | undefined;
  clock(): number;
  webhookUrl?: ((token: string) => string) | undefined;
  /** Mark a local step's body as started — emits `step.started` and (optionally) a `running` checkpoint. */
  startStep(step: StepRecord): Promise<void>;
  completeStep(step: StepRecord & { output: unknown }): Promise<void>;
  failStep(step: StepRecord & { error: StepError }): Promise<void>;
  callRemote<TInput, TOutput>(
    runId: string,
    seq: number,
    step: RemoteStepDef<TInput, TOutput>,
    input: TInput,
    queue?: string,
    transport?: string,
    admission?: { priority?: number | undefined; fairnessKey?: string | undefined },
  ): Promise<TOutput>;
  /** Start a child run once, deferred so it can't reentrantly resume a still-running parent. */
  startChild(workflow: string, input: unknown, id: string, priority?: number): void;
  /** Deliver an op to a durable entity (deferred), optionally with a `reply` token for the result. */
  signalEntity?(name: string, key: string, op: string, arg: unknown, reply?: string): void;
  /** Run a local step body through the registered step interceptors (identity if none). */
  interceptStep?<T>(invocation: StepInvocation, body: () => Promise<T>): Promise<T>;
}

/** The per-run logical position counter. `rewind()` gives a position back (see `ctx.patched`). */
class Position {
  private seq = -1;
  next(): number {
    this.seq += 1;
    return this.seq;
  }
  rewind(): void {
    this.seq -= 1;
  }
}

/**
 * Build the {@link WorkflowCtx} handed to a workflow body. Every primitive is a closure over the
 * position counter (the per-run logical position) and the saga `compensations` stack, so `task`/
 * `child` compose `step`/`waitForSignal` directly. All durability goes through {@link CtxHost}, so
 * the workflow body stays deterministic.
 */
export function createWorkflowCtx(
  host: CtxHost,
  runId: string,
  compensations: Compensation[],
  workflow = '',
): WorkflowCtx {
  const { store, replay } = host;
  const pos = new Position();

  // Read the checkpoint at `seq`: from the per-execution snapshot when present (no DB round-trip),
  // otherwise from the live store. Absence in the snapshot means "written after the snapshot" (the
  // signal/timer/child this resume wakes on, or nothing yet) — those MUST hit the store. Identical
  // behaviour to a raw `store.getCheckpoint`, just memoized for the completed prefix.
  const readCheckpoint = (seq: number): Promise<StepCheckpoint | null> | StepCheckpoint => {
    const hit = replay?.get(seq);
    if (hit !== undefined) return hit;
    return store.getCheckpoint(runId, seq);
  };

  // Persist a checkpoint AND reflect it in the snapshot, so a later same-execution read of this seq
  // (e.g. a re-read within the same call) sees it instead of falling back to the store.
  const writeCheckpoint = async (cp: StepCheckpoint): Promise<void> => {
    await store.saveCheckpoint(cp);
    replay?.set(cp.seq, cp);
  };

  const step = async <T>(
    name: string,
    fn: (log: StepLogger) => Promise<T>,
    options?: StepOptions,
  ): Promise<T> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.name !== name) {
      throw new NonDeterminismError(runId, current, name, existing.name);
    }
    if (existing && existing.status === 'completed') {
      // Register the compensation on replay too, so a saga undoes ALL completed steps — even
      // those done in an earlier (since-suspended) pass — not just the ones run this pass.
      if (options?.compensate) compensations.push({ name, fn: options.compensate });
      return existing.output as T;
    }
    const maxAttempts = Math.max(1, options?.retries ?? 1);
    const startedAt = new Date();
    // Announce the body has begun (and, when enabled, checkpoint it `running`) so the step is
    // visible in flight — not only once it settles. Skipped on replay: a completed step returns
    // above before reaching here, so this fires once, when the body actually first runs.
    await host.startStep({
      runId,
      seq: current,
      name,
      kind: 'local',
      attempts: 1,
      enqueuedAt: startedAt,
      startedAt,
    });
    for (let attempt = 1; ; attempt += 1) {
      // Events are scoped per attempt — a retry starts a clean log, so the checkpoint reflects
      // only the attempt that actually completed (or the final failing one).
      const events: StepEvent[] = [];
      try {
        const invocation: StepInvocation = {
          runId,
          workflow,
          stepName: name,
          seq: current,
          attempt,
        };
        const body = () => fn(createStepLogger(events, host.clock));
        const output = host.interceptStep
          ? await host.interceptStep(invocation, body)
          : await body();
        await host.completeStep({
          runId,
          seq: current,
          name,
          kind: 'local',
          output,
          events,
          attempts: attempt,
          enqueuedAt: startedAt,
          startedAt,
        });
        if (options?.compensate) compensations.push({ name, fn: options.compensate });
        return output;
      } catch (err) {
        if (err instanceof FatalError || attempt >= maxAttempts) {
          await host.failStep({
            runId,
            seq: current,
            name,
            kind: 'local',
            error: {
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            events,
            attempts: attempt,
            enqueuedAt: startedAt,
            startedAt,
          });
          throw err;
        }
        // Wait out the backoff before the next attempt (no-op when backoffMs is unset).
        const wait = backoffDelay(attempt, options);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  // Exactly-once DB step: run the body and write the step checkpoint in ONE store transaction, so the
  // business write commits atomically with the "done" marker (a plain step checkpoints AFTER the body,
  // so a crash in between re-runs it). Replay returns the recorded output without re-running.
  const transaction = async <T>(name: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (!store.transaction) {
      throw new Error(
        'ctx.transaction needs a store that supports transactions (the SQL adapters do). Use ctx.step for non-transactional work.',
      );
    }
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.name !== name) {
      throw new NonDeterminismError(runId, current, name, existing.name);
    }
    if (existing && existing.status === 'completed') return existing.output as T;
    return store.transaction(async (tx) => {
      const output = await fn(tx.raw);
      const cp = instantCheckpoint({ runId, seq: current, name, kind: 'local', output });
      await tx.saveCheckpoint(cp);
      // Reflect the committed checkpoint in the snapshot, keeping the writeback invariant uniform.
      replay?.set(current, cp);
      return output;
    });
  };

  // Shared by sleep / sleepUntil: record a durable timer at this position and suspend until `wakeAt`
  // (epoch ms). The wakeAt is computed by the caller — but only used on the first run; on replay the
  // recorded checkpoint's wakeAt wins, so a clock change can't shift an already-scheduled timer.
  const suspendUntil = async (wakeAt: () => number): Promise<void> => {
    const current = pos.next();
    const now = host.clock();
    const existing = await readCheckpoint(current);
    if (existing) {
      // Timer already recorded: resume if due, otherwise re-suspend cheaply.
      if (now >= (existing.wakeAt ?? 0)) return;
      throw new WorkflowSuspended(existing.wakeAt ?? now);
    }
    const at = wakeAt();
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: 'sleep', kind: 'sleep', wakeAt: at }),
    );
    throw new WorkflowSuspended(at);
  };

  const sleep = (duration: string | number): Promise<void> =>
    suspendUntil(() => host.clock() + parseDuration(duration));

  const sleepUntil = (when: Date | number): Promise<void> =>
    suspendUntil(() => (typeof when === 'number' ? when : when.getTime()));

  // End this run and hand off to a fresh execution (clean history) with the new input. Terminal —
  // it always throws, so any code after it in the workflow is unreachable.
  const continueAsNew = (input?: unknown): Promise<never> => {
    throw new ContinueAsNew(input);
  };

  // NOTE (determinism): a bounded wait consumes TWO logical positions (deadline + wait), an
  // unbounded one consumes ONE. So adding or removing `{ timeoutMs }` on an existing `waitForSignal`
  // shifts the seq of every later step — treat it as a workflow-version change for in-flight runs.
  // Consume a buffered signal (one delivered before this run was waiting), recording it as the
  // signal checkpoint at `seq` so it resumes immediately instead of suspending. Replay-safe: the
  // checkpoint makes the consumption deterministic.
  const consumeBuffered = async <T>(token: string, seq: number): Promise<{ value: T } | null> => {
    const buffered = await store.takeBufferedSignal(token);
    if (!buffered) return null;
    await writeCheckpoint(
      instantCheckpoint({
        runId,
        seq,
        name: `signal:${token}`,
        kind: 'signal',
        output: buffered.payload,
      }),
    );
    return { value: buffered.payload as T };
  };

  const waitForSignal = async <T>(token: string, opts?: { timeoutMs?: number }): Promise<T> => {
    if (opts?.timeoutMs == null) {
      const current = pos.next();
      const existing = await readCheckpoint(current);
      if (existing && existing.status === 'completed') return existing.output as T;
      const buffered = await consumeBuffered<T>(token, current);
      if (buffered) return buffered.value;
      await store.putSignalWaiter({ token, runId, seq: current });
      throw new WorkflowSuspended();
    }
    const timeoutMs = opts.timeoutMs;
    const deadlineSeq = pos.next();
    const waitSeq = pos.next();
    // The deadline is recorded durably as a timer checkpoint so replay knows it; the run also gets a
    // run-level wakeAt (via WorkflowSuspended) so the timer poller resumes it at the deadline.
    const recorded = await readCheckpoint(deadlineSeq);
    const deadline = recorded?.wakeAt ?? host.clock() + timeoutMs;
    if (!recorded) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: deadlineSeq,
          name: `timeout:${token}`,
          kind: 'sleep',
          wakeAt: deadline,
        }),
      );
    }
    const waited = await readCheckpoint(waitSeq);
    if (waited && waited.status === 'completed') return waited.output as T;
    const buffered = await consumeBuffered<T>(token, waitSeq);
    if (buffered) return buffered.value;
    if (host.clock() >= deadline) {
      await store.takeSignalWaiter(token).catch(() => undefined);
      throw new SignalTimeoutError(token, timeoutMs);
    }
    await store.putSignalWaiter({ token, runId, seq: waitSeq });
    throw new WorkflowSuspended(deadline);
  };

  // Wait for a named event delivered by engine.publishEvent(name, payload). Like waitForSignal, but
  // name-based pub/sub with optional `match` filtering — the token embeds name + match (see events.ts),
  // so a publish fans out to the runs whose match the payload satisfies.
  const waitForEvent = async <T>(
    name: string,
    opts?: { match?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<T> => {
    if (opts?.timeoutMs == null) {
      const current = pos.next();
      const token = eventToken(name, opts?.match, runId, current);
      const existing = await readCheckpoint(current);
      if (existing && existing.status === 'completed') return existing.output as T;
      await store.putSignalWaiter({ token, runId, seq: current });
      throw new WorkflowSuspended();
    }
    const timeoutMs = opts.timeoutMs;
    const deadlineSeq = pos.next();
    const waitSeq = pos.next();
    const token = eventToken(name, opts.match, runId, waitSeq);
    const recorded = await readCheckpoint(deadlineSeq);
    const deadline = recorded?.wakeAt ?? host.clock() + timeoutMs;
    if (!recorded) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: deadlineSeq,
          name: `timeout:event:${name}`,
          kind: 'sleep',
          wakeAt: deadline,
        }),
      );
    }
    const waited = await readCheckpoint(waitSeq);
    if (waited && waited.status === 'completed') return waited.output as T;
    if (host.clock() >= deadline) {
      await store.takeSignalWaiter(token).catch(() => undefined);
      throw new SignalTimeoutError(`event:${name}`, timeoutMs);
    }
    await store.putSignalWaiter({ token, runId, seq: waitSeq });
    throw new WorkflowSuspended(deadline);
  };

  // An external task = a checkpointed dispatch + a wait for its async-completion `Completion`
  // (delivered by engine.completeTask/failTask). The whole "fire at a foreign system, suspend,
  // resume when it reports back" pattern as one call.
  const task = async <T>(
    name: string,
    dispatch: () => Promise<void>,
    options?: StepOptions,
  ): Promise<T> => {
    await step(`task:dispatch:${name}`, dispatch, options);
    return unwrapCompletion<T>(await waitForSignal(`task:${runId}:${name}`), `task "${name}"`);
  };

  // Child workflow (await result): start it once, then suspend on a `child:<id>` waiter the child
  // signals on its terminal state (see engine.notifyParent).
  const child = async <T>(
    workflow: WorkflowRef,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<T> => {
    const { childId, priority } = normalizeChildOptions(options);
    const current = pos.next();
    const id = childId ?? `${runId}.child.${current}`;
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') {
      return unwrapCompletion<T>(existing.output, `child "${id}"`);
    }
    await store.putSignalWaiter({ token: `child:${id}`, runId, seq: current });
    if (!(await store.getRun(id))) host.startChild(workflowName(workflow), input, id, priority);
    // Make the awaited child visible in the parent's timeline WHILE it runs: a `running` placeholder
    // at this seq with the same `signal:child:<id>` name the signal resolution later overwrites as
    // `completed`. So the dashboard shows the child node (and can inline-expand it) live, instead of
    // it appearing only when it finishes. Written once (skipped on replay, where `existing` is set);
    // `running` is ignored by replay history, so it never short-circuits determinism.
    if (!existing) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: current,
          name: `signal:child:${id}`,
          kind: 'signal',
          status: 'running',
        }),
      );
    }
    throw new WorkflowSuspended();
  };

  // Child workflow (fire-and-forget): dispatch it once and return its id WITHOUT suspending. The
  // start is checkpointed at this position so replay returns the same id without re-dispatching, and
  // is idempotent by id, so `child(..., sameId)` later joins the same run rather than starting a new
  // one (start + join scatter-gather).
  const startChild = async (
    workflow: WorkflowRef,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<string> => {
    const { childId, priority } = normalizeChildOptions(options);
    const current = pos.next();
    const id = childId ?? `${runId}.child.${current}`;
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return existing.output as string;
    if (!(await store.getRun(id))) host.startChild(workflowName(workflow), input, id, priority);
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: `spawn:${id}`, kind: 'local', output: id }),
    );
    return id;
  };

  // Call a durable entity op and await its result: register a reply waiter at this position, dispatch
  // the op with the reply token, and suspend until the entity signals the result back (checkpointed,
  // so replay returns it without re-dispatching).
  const callEntity = async <R>(
    name: string,
    key: string,
    op: string,
    arg?: unknown,
  ): Promise<R> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return existing.output as R;
    const reply = `entityreply:${runId}:${current}`;
    await store.putSignalWaiter({ token: reply, runId, seq: current });
    host.signalEntity?.(name, key, op, arg, reply);
    throw new WorkflowSuspended();
  };

  // Send a durable entity op without awaiting a result — dispatched once (checkpointed, replay-safe).
  const signalEntity = async (
    name: string,
    key: string,
    op: string,
    arg?: unknown,
  ): Promise<void> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return;
    host.signalEntity?.(name, key, op, arg);
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: `entitysig:${name}:${key}`, kind: 'local' }),
    );
  };

  // A breakpoint = a visible `pending` checkpoint + a signal waiter the dashboard resumes via
  // `engine.continue`. Reuses the signal machinery, so resume overwrites the pending checkpoint
  // with a completed one and the run replays past it.
  const breakpoint = async (label?: string): Promise<void> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return;
    if (!existing) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: current,
          name: label ? `breakpoint:${label}` : 'breakpoint',
          kind: 'signal',
          status: 'pending',
        }),
      );
      await store.putSignalWaiter({ token: breakpointToken(runId, current), runId, seq: current });
    }
    throw new WorkflowSuspended();
  };

  // Guard an in-place change: a fresh run records a `patch:<id>` marker here and takes the new
  // branch; a run recorded under the OLD code finds a real step at this position instead, so we
  // rewind the logical position (the marker is transparent to it) and return false — its replay
  // reads that old step next and follows the old branch. No position shift → no corruption.
  const patched = async (id: string): Promise<boolean> => {
    const marker = `patch:${id}`;
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing) {
      if (existing.name === marker) return true;
      if (existing.name.startsWith('patch:')) {
        throw new NonDeterminismError(runId, current, marker, existing.name);
      }
      pos.rewind(); // not a marker: an old run's step lives here — give the position back to it
      return false;
    }
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: marker, kind: 'local', output: true }),
    );
    return true;
  };

  // An update point: suspend on a run-scoped `update:<runId>:<name>` token that engine.update
  // delivers to (after its validator passes). Reuses the signal machinery; run-scoped like task/child.
  const onUpdate = <T>(name: string, opts?: { timeoutMs?: number }): Promise<T> =>
    waitForSignal<T>(`update:${runId}:${name}`, opts);

  // A queryable named value: a checkpoint whose `name` is `event:<key>`, so the latest value for a
  // key is just the highest-seq such checkpoint (read by engine.getEvent). Replay-idempotent.
  const setEvent = async (key: string, value: unknown): Promise<void> => {
    const current = pos.next();
    const name = `event:${key}`;
    const existing = await readCheckpoint(current);
    if (existing && existing.name !== name) {
      throw new NonDeterminismError(runId, current, name, existing.name);
    }
    if (existing && existing.status === 'completed') return; // replay: already published
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name, kind: 'local', output: value }),
    );
  };

  // A durable webhook reserves a logical position NOW to mint a stable token, so the url can be
  // handed to a third party before `wait()` suspends. `wait()` then parks on that same position
  // until the callback lands as engine.signal(token, body) — single position, replay-safe.
  const webhook = <T>(): DurableWebhook<T> => {
    const current = pos.next();
    const token = `wh:${runId}:${current}`;
    const wait = async (): Promise<T> => {
      const existing = await readCheckpoint(current);
      if (existing && existing.status === 'completed') return existing.output as T;
      await store.putSignalWaiter({ token, runId, seq: current });
      throw new WorkflowSuspended();
    };
    return { token, url: host.webhookUrl?.(token), wait };
  };

  // Deterministic non-deterministic sources: each is a checkpointed local step, so the value is
  // captured on the first run and replayed verbatim (a raw Date.now()/Math.random() inside a
  // workflow would differ across replays and corrupt the run).
  const now = () => step('now', async () => host.clock());
  const random = () => step('random', async () => Math.random());
  const uuid = () => step('uuid', async () => globalThis.crypto.randomUUID());

  return {
    runId,
    step,
    transaction,
    callEntity,
    signalEntity,
    sleep,
    sleepUntil,
    continueAsNew,
    waitForSignal,
    waitForEvent,
    task,
    child,
    startChild,
    breakpoint,
    webhook,
    setEvent,
    onUpdate,
    patched,
    now,
    random,
    uuid,
    call: (remote, input, opts) =>
      host.callRemote(runId, pos.next(), remote, input, opts?.queue, opts?.transport, {
        priority: opts?.priority,
        fairnessKey: opts?.fairnessKey,
      }),
  };
}
