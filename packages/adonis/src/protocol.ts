import type { RemoteTask, StepEvent, StepLogger, StepResult } from './interfaces.js';
import { createStepLogger } from './step-logger.js';

/** Canonical step id — the stable identity of a step within a run, used for dedupe and
 *  correlation. The format is part of the cross-language wire contract (Python builds the same). */
export function stepId(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

/** Deterministic signal token a breakpoint suspends on — derived from its logical position. Shared
 *  so `ctx.breakpoint` (which records it) and `engine.continue` (which signals it) agree. */
export const breakpointToken = (runId: string, seq: number): string => `bp:${runId}:${seq}`;

/** A remote-worker step body. The optional `log` records sub-process outcomes and debug/error
 *  lines that ride back on the result — the TypeScript twin of the Python SDK's `StepContext`. */
export type StepHandler = (input: unknown, log: StepLogger) => Promise<unknown> | unknown;

/**
 * Run `handler` for `task` and produce the wire-format {@link StepResult}. Pure (no transport,
 * no I/O beyond the handler), so every transport — and any language port — can share the exact
 * same completed / failed / no-handler contract instead of re-deriving it.
 */
export async function runStepHandler(
  task: RemoteTask,
  handler: StepHandler | undefined,
): Promise<StepResult> {
  // Stamp the worker's pickup time so the engine can report queue-wait (startedAt − enqueuedAt).
  // This is the one place every transport funnels through, so timing comes for free everywhere.
  const base = { runId: task.runId, seq: task.seq, stepId: task.stepId, startedAt: Date.now() };
  if (!handler) {
    return {
      ...base,
      status: 'failed',
      error: { message: `no handler for ${task.name}`, retryable: false },
    };
  }
  const events: StepEvent[] = [];
  const withEvents = (result: StepResult): StepResult =>
    events.length > 0 ? { ...result, events } : result;
  try {
    const output = await handler(task.input, createStepLogger(events, Date.now));
    return withEvents({ ...base, status: 'completed', output });
  } catch (err) {
    // Carry `code`/`retryable` off the thrown error if present, so the engine's durable retry can
    // honour a worker's "don't retry this" verdict (e.g. a declined card).
    const e = err as { message?: string; code?: string; retryable?: boolean };
    return withEvents({
      ...base,
      status: 'failed',
      error: {
        message: err instanceof Error ? err.message : String(err),
        ...(typeof e?.code === 'string' ? { code: e.code } : {}),
        ...(typeof e?.retryable === 'boolean' ? { retryable: e.retryable } : {}),
      },
    });
  }
}
