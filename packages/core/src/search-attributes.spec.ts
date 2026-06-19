import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { matchesAttributes } from './search-attributes.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('matchesAttributes', () => {
  it('matches eq/ne/gt/gte/lt/lte and requires every filter', () => {
    const a = { amount: 100, customer: 'acme', vip: true };
    expect(matchesAttributes(a, [{ key: 'amount', op: 'gt', value: 50 }])).toBe(true);
    expect(matchesAttributes(a, [{ key: 'amount', op: 'lt', value: 50 }])).toBe(false);
    expect(matchesAttributes(a, [{ key: 'amount', op: 'gte', value: 100 }])).toBe(true);
    expect(matchesAttributes(a, [{ key: 'amount', op: 'lte', value: 99 }])).toBe(false);
    expect(matchesAttributes(a, [{ key: 'customer', op: 'eq', value: 'acme' }])).toBe(true);
    expect(matchesAttributes(a, [{ key: 'customer', op: 'ne', value: 'acme' }])).toBe(false);
    expect(matchesAttributes(a, [{ key: 'vip', op: 'eq', value: true }])).toBe(true);
    // every filter must hold (AND)
    expect(
      matchesAttributes(a, [
        { key: 'amount', op: 'gte', value: 100 },
        { key: 'customer', op: 'eq', value: 'acme' },
      ]),
    ).toBe(true);
    expect(
      matchesAttributes(a, [
        { key: 'amount', op: 'gte', value: 100 },
        { key: 'customer', op: 'eq', value: 'nope' },
      ]),
    ).toBe(false);
  });

  it('a missing key never matches (no attributes at all = no match for any filter)', () => {
    expect(matchesAttributes(undefined, [{ key: 'x', op: 'eq', value: 1 }])).toBe(false);
    expect(matchesAttributes({ a: 1 }, [{ key: 'missing', op: 'gt', value: 0 }])).toBe(false);
  });

  it('empty/undefined filters match everything', () => {
    expect(matchesAttributes(undefined, undefined)).toBe(true);
    expect(matchesAttributes({ a: 1 }, [])).toBe(true);
  });
});

describe('engine: search attributes on start + query', () => {
  it('stamps run-scoped attributes and filters runs by typed range queries', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('order', '1', async (_ctx, input) => (input as { id: string }).id);

    await engine.start('order', { id: 'a' }, 'a', {
      searchAttributes: { amount: 30, tier: 'free' },
    });
    await engine.start('order', { id: 'b' }, 'b', {
      searchAttributes: { amount: 200, tier: 'pro' },
    });
    await engine.start('order', { id: 'c' }, 'c', {
      searchAttributes: { amount: 500, tier: 'pro' },
    });

    expect((await store.getRun('b'))?.searchAttributes).toEqual({ amount: 200, tier: 'pro' });

    const big = await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] });
    expect(big.map((r) => r.id).sort()).toEqual(['b', 'c']);

    const proSmall = await store.listRuns({
      attributes: [
        { key: 'tier', op: 'eq', value: 'pro' },
        { key: 'amount', op: 'lt', value: 300 },
      ],
    });
    expect(proSmall.map((r) => r.id)).toEqual(['b']);
  });
});
