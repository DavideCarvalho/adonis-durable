import type { StepCheckpoint, StepError, StepEvent, StepKind } from './interfaces.js';
import { stepId } from './protocol.js';

/** Drop an empty events array to `undefined` (the repeated `events?.length ? events : undefined`). */
function nonEmptyEvents(events: StepEvent[] | undefined): StepEvent[] | undefined {
  return events && events.length > 0 ? events : undefined;
}

/**
 * Build a *phased* step checkpoint — one with distinct enqueue/run/finish timestamps (a local step
 * that is running/completed/failed, or a pending remote/sleep step). Computes the deterministic
 * `stepId` and normalizes empty event arrays, so the engine's running/completed/failed/pending
 * checkpoint literals are constructed in exactly one place instead of ~8.
 *
 * For instantaneous checkpoints (sleep timers, markers, delivered signals) use {@link instantCheckpoint}.
 */
export function stepCheckpoint(p: {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  status: StepCheckpoint['status'];
  attempts: number;
  enqueuedAt: Date;
  startedAt: Date;
  finishedAt: Date;
  input?: unknown;
  output?: unknown;
  error?: StepError | undefined;
  events?: StepEvent[] | undefined;
  workerGroup?: string | undefined;
  wakeAt?: number | undefined;
  parallelGroup?: string | undefined;
}): StepCheckpoint {
  return {
    runId: p.runId,
    seq: p.seq,
    name: p.name,
    kind: p.kind,
    stepId: stepId(p.runId, p.seq),
    status: p.status,
    input: p.input,
    output: p.output,
    error: p.error,
    events: nonEmptyEvents(p.events),
    attempts: p.attempts,
    workerGroup: p.workerGroup,
    wakeAt: p.wakeAt,
    parallelGroup: p.parallelGroup,
    enqueuedAt: p.enqueuedAt,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
  };
}

/**
 * Build an *instantaneous* checkpoint — one with no distinct enqueue/run/finish phases (a durable
 * sleep timer, a breakpoint marker, a delivered signal, a published `setEvent` value, a `patched`
 * marker). All three timestamps collapse to now and `attempts` is 1. Collapses what was five
 * near-identical 10-field `saveCheckpoint({...})` literals into one builder.
 */
export function instantCheckpoint(p: {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  status?: StepCheckpoint['status'];
  output?: unknown;
  wakeAt?: number;
  parallelGroup?: string | undefined;
}): StepCheckpoint {
  const at = new Date();
  return {
    runId: p.runId,
    seq: p.seq,
    name: p.name,
    kind: p.kind,
    stepId: stepId(p.runId, p.seq),
    status: p.status ?? 'completed',
    output: p.output,
    wakeAt: p.wakeAt,
    parallelGroup: p.parallelGroup,
    attempts: 1,
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
  };
}
