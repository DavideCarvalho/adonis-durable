import { describe, expect, it } from 'vitest';
import { fromJson, toJson } from './queue.js';

describe('queue serialization', () => {
  it('round-trips a RemoteTask through JSON', () => {
    const task = {
      runId: 'r1',
      seq: 3,
      name: 'payments.charge',
      stepId: 'r1:3',
      group: 'payments',
      input: { amount: 100, currency: 'USD', nested: { a: [1, 2, 3] } },
      attempt: 1,
    };
    expect(fromJson(toJson(task))).toEqual(task);
  });

  it('drops non-JSON members (functions / undefined) exactly as a broker would', () => {
    const value: any = { a: 1, fn: () => 1, u: undefined, b: 'keep' };
    expect(toJson(value)).toEqual({ a: 1, b: 'keep' });
  });

  it('decodes a payload a driver handed back as a raw string', () => {
    const original = { runId: 'r1', seq: 1 };
    expect(fromJson(JSON.stringify(original))).toEqual(original);
  });

  it('throws on a circular value (cannot cross the wire)', () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => toJson(cyclic)).toThrow();
  });
});
