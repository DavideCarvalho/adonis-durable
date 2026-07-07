import { describe, expect, it } from 'vitest';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  stepConfigOf,
  stepNameOf,
} from '../../src/step-name-symbol.js';

describe('step-name-symbol', () => {
  it('reads a stamped step name off a function ref', () => {
    const fn = Object.assign(async () => 1, { [DURABLE_STEP_NAME]: 'billing:charge' });
    expect(stepNameOf(fn)).toBe('billing:charge');
  });

  it('returns undefined for an unstamped ref or a non-function (e.g. a string)', () => {
    expect(stepNameOf(async () => 1)).toBeUndefined();
    expect(stepNameOf('billing:charge')).toBeUndefined();
    expect(stepNameOf(undefined)).toBeUndefined();
  });

  it('reads a stamped dispatch config, and undefined when absent', () => {
    const fn = Object.assign(async () => 1, {
      [DURABLE_STEP_CONFIG]: { retries: 3, timeoutMs: 500 },
    });
    expect(stepConfigOf(fn)).toEqual({ retries: 3, timeoutMs: 500 });
    expect(stepConfigOf(async () => 1)).toBeUndefined();
    expect(stepConfigOf('name')).toBeUndefined();
  });

  it('uses the GLOBAL symbol registry (Symbol.for), so a duplicate module copy reads the same key', () => {
    // A second copy of the module would compute Symbol.for('@agora/durable:step-name') — the SAME
    // token. Simulate that: stamp under the raw registry symbol and read via stepNameOf.
    const key = Symbol.for('@agora/durable:step-name');
    expect(key).toBe(DURABLE_STEP_NAME);
    const fn = Object.assign(async () => 1, { [key]: 'x:y' });
    expect(stepNameOf(fn)).toBe('x:y');
  });
});
