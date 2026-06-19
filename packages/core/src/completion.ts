import { FatalError } from './errors.js';

/**
 * The payload an external `ctx.task` / child run delivers back on its completion signal: either a
 * value or a failure. One typed envelope so `task` and `child` share the same unwrap (instead of
 * sniffing ad-hoc `__error` keys).
 */
export type Completion<T> = { ok: true; value: T } | { ok: false; error: string };

/** Read a `Completion` from a signal payload: return the value, or throw a FatalError if it failed. */
export function unwrapCompletion<T>(payload: unknown, label: string): T {
  const c = payload as Completion<T> | null;
  if (c && typeof c === 'object' && 'ok' in c && c.ok === false) {
    throw new FatalError(`${label} failed: ${c.error}`);
  }
  return (c as { value: T } | null)?.value as T;
}
