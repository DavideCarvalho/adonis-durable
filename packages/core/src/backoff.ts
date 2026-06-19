import type { StepOptions } from './interfaces.js';

/** Delay in ms before the next retry attempt, per a step's `StepOptions` backoff config. Shared by
 *  the local-step retry loop and the durable remote-step retry, so they stay consistent. */
export function backoffDelay(attempt: number, options?: StepOptions): number {
  const base = options?.backoffMs ?? 0;
  if (base <= 0) return 0;
  const raw = options?.backoff === 'exp' ? base * 2 ** (attempt - 1) : base;
  const capped = options?.backoffMaxMs ? Math.min(raw, options.backoffMaxMs) : raw;
  return options?.jitter ? Math.round(capped * (0.5 + Math.random() * 0.5)) : capped;
}
