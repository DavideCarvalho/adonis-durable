import type { BackoffStrategy } from './interfaces.js';

/**
 * Cross-package step-name stamp. The `@Step` decorator (and `defineStep`) writes a method's derived
 * routing name under this key; `ctx.step` reads it (via {@link stepNameOf}) to route a
 * method-reference call to the same handler a worker registers by name.
 *
 * `Symbol.for` (the GLOBAL registry), NOT a plain `Symbol()` — so a duplicate copy of this module
 * (pnpm peer-dependency multiplexing, or a dual ESM/CJS load) still reads the SAME key. A plain
 * `Symbol()` would mint a distinct token per copy, so a decorator running against one copy could
 * stamp a name a different copy's `ctx.step` can never read back. Uses the `@agora/` wire namespace
 * to match {@link import('./workflow-ref.js').WORKFLOW_META_KEY}.
 */
export const DURABLE_STEP_NAME: unique symbol = Symbol.for('@agora/durable:step-name');

/**
 * Cross-package step-DISPATCH-POLICY stamp. `@Step({ retries, backoff, backoffMs, backoffMaxMs,
 * jitter, timeoutMs })` writes the def-level durable-retry/liveness policy under this key; `ctx.step`
 * reads it (via {@link stepConfigOf}) and merges it with any per-call {@link import('./interfaces.js').StepDispatchOpts}
 * override to build the dispatched {@link import('./interfaces.js').StepDef}. Same `Symbol.for`
 * rationale as {@link DURABLE_STEP_NAME}.
 */
export const DURABLE_STEP_CONFIG: unique symbol = Symbol.for('@agora/durable:step-config');

/**
 * The def-level durable-dispatch policy a `@Step(...)` can stamp on a method: retry/backoff and the
 * remote-liveness `timeoutMs` — the dispatch-relevant subset of the engine's `StepOptions`. Read off
 * a handler reference via {@link stepConfigOf}; a per-call {@link import('./interfaces.js').StepDispatchOpts}
 * passed to `ctx.step(ref, input, opts)` overrides these field-by-field.
 */
export interface StepConfig {
  /** Max attempts before the step (and run) fails. */
  retries?: number | undefined;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: BackoffStrategy | undefined;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number | undefined;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number | undefined;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean | undefined;
  /** Liveness window for the dispatched step: no result/heartbeat within this many ms presumes the
   *  worker dead and fails the dispatch with a `RemoteStepTimeout` (retryable — re-dispatches per
   *  `retries`). Omit to wait indefinitely. */
  timeoutMs?: number | undefined;
}

function isStepConfig(value: unknown): value is StepConfig {
  return typeof value === 'object' && value !== null;
}

/**
 * A method carrying its `@Step`-stamped routing name (and, optionally, its dispatch policy).
 * `ctx.step(ref, input)` reads the name via {@link stepNameOf} — the reference itself is never
 * invoked directly by the caller's process (the worker serving that name re-resolves the real
 * handler), so an unbound `this` on `ref` is irrelevant; `ref` is purely a typed, refactor-safe
 * handle onto the stamped name (and policy).
 */
export type StepRef<TInput = unknown, TOutput = unknown> = ((
  input: TInput,
) => Promise<TOutput> | TOutput) & {
  [DURABLE_STEP_NAME]?: string | undefined;
  [DURABLE_STEP_CONFIG]?: StepConfig | undefined;
};

/** Read the `@Step`-stamped routing name off a function ref. `undefined` for anything unstamped
 *  (including a plain string — {@link stepNameOf} only reads function refs; a caller passing a
 *  string already has the routing name and dispatches it directly). */
export function stepNameOf(ref: unknown): string | undefined {
  if (typeof ref !== 'function') return undefined;
  const stamped = (ref as { [DURABLE_STEP_NAME]?: unknown })[DURABLE_STEP_NAME];
  return typeof stamped === 'string' ? stamped : undefined;
}

/** Read the `@Step`-stamped dispatch policy off a function ref. `undefined` for anything unstamped
 *  (including a plain string — a cross-runtime string-name call has no def-level policy to read; pass
 *  it via {@link import('./interfaces.js').StepDispatchOpts} instead). */
export function stepConfigOf(ref: unknown): StepConfig | undefined {
  if (typeof ref !== 'function') return undefined;
  const stamped = (ref as { [DURABLE_STEP_CONFIG]?: unknown })[DURABLE_STEP_CONFIG];
  return isStepConfig(stamped) ? stamped : undefined;
}
