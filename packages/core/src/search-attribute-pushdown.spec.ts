import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './interfaces.js';
import { normalizeAttributeRows } from './search-attributes.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

const at = new Date('2026-06-11T00:00:00.000Z');

function run(id: string, attrs: WorkflowRun['searchAttributes']): WorkflowRun {
  return {
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'running',
    input: {},
    searchAttributes: attrs,
    createdAt: at,
    updatedAt: at,
  };
}

describe('normalizeAttributeRows', () => {
  it('explodes attributes into one typed row per key', () => {
    const rows = normalizeAttributeRows('r1', { amount: 200, tier: 'pro', vip: true });
    expect(rows).toEqual([
      { runId: 'r1', key: 'amount', strValue: null, numValue: 200 },
      { runId: 'r1', key: 'tier', strValue: 'pro', numValue: null },
      { runId: 'r1', key: 'vip', strValue: 'true', numValue: null },
    ]);
  });

  it('returns [] for a run with no attributes', () => {
    expect(normalizeAttributeRows('r1', undefined)).toEqual([]);
  });
});

describe('in-memory store: attribute index pushdown', () => {
  it('answers equality + range predicates correctly', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', { amount: 30, tier: 'free' }));
    await store.createRun(run('b', { amount: 200, tier: 'pro' }));
    await store.createRun(run('c', { amount: 500, tier: 'pro' }));

    const big = await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] });
    expect(big.map((r) => r.id).sort()).toEqual(['b', 'c']);

    const proSmall = await store.listRuns({
      attributes: [
        { key: 'tier', op: 'eq', value: 'pro' },
        { key: 'amount', op: 'lt', value: 300 },
      ],
    });
    expect(proSmall.map((r) => r.id)).toEqual(['b']);

    const free = await store.listRuns({ attributes: [{ key: 'tier', op: 'ne', value: 'pro' }] });
    expect(free.map((r) => r.id)).toEqual(['a']);
  });

  it('uses the attribute index, not a full per-run scan (pushdown)', async () => {
    const store = new InMemoryStateStore();
    // Seed many non-matching runs; only one matches the predicate.
    for (let i = 0; i < 50; i++) await store.createRun(run(`x${i}`, { amount: 1 }));
    await store.createRun(run('hit', { amount: 999 }));

    // If pushdown works, the key-indexed side-table narrows candidates to {hit} BEFORE any per-run
    // compare, so the materialized candidate set is 1 — not a full scan over all 51 runs.
    const res = await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 500 }] });
    expect(res.map((r) => r.id)).toEqual(['hit']);
    expect(store.lastAttributeCandidates).toBe(1);
  });

  it('reindexes when searchAttributes are updated', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', { tier: 'free' }));
    expect(
      (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).length,
    ).toBe(0);
    await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
    const res = await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] });
    expect(res.map((r) => r.id)).toEqual(['a']);
    // Old value no longer matches.
    expect(
      (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] })).length,
    ).toBe(0);
  });
});
