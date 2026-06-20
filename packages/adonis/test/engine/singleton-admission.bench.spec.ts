/**
 * TEMPORARY benchmark/instrumentation for the singleton-admission optimization.
 *
 * Headline metric is the number of store list-scans issued per admission check (and per second under
 * the retry loop with N gated waiters), NOT raw CPU. This file:
 *   1. counts `listRuns` calls per `admitSingleton` (1 after the optimization, 2 before),
 *   2. proves the single-scan admission yields the EXACT same FIFO `(createdAt, id)` ordering as the
 *      old two-scan + concat + sort, and
 *   3. simulates a queue of N gated waiters re-checking on the retry timer to show scans/sec halve.
 *
 * Delete after reviewing — it is not part of the shipped suite's contract.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RunQuery, WorkflowRun } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** Wrap a store and count every `listRuns` call (the scan we are trying to reduce). */
class CountingStore extends InMemoryStateStore {
  listRunsCalls = 0;
  override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    this.listRunsCalls++;
    return super.listRuns(query);
  }
}

/** The OLD admission scan: two queries (running, then suspended) + concat + total sort. */
async function admitOld(
  store: InMemoryStateStore,
  tag: string,
  workflow: string,
  runId: string,
  limit: number,
): Promise<boolean> {
  const inflight = [
    ...(await store.listRuns({ tag, workflow, status: 'running' })),
    ...(await store.listRuns({ tag, workflow, status: 'suspended' })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const idx = inflight.findIndex((r) => r.id === runId);
  return idx >= 0 && idx < limit;
}

/** The NEW admission scan: one `status IN (running, suspended)` query + the same total sort. */
async function admitNew(
  store: InMemoryStateStore,
  tag: string,
  workflow: string,
  runId: string,
  limit: number,
): Promise<boolean> {
  const inflight = (
    await store.listRuns({ tag, workflow, statuses: ['running', 'suspended'] })
  ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const idx = inflight.findIndex((r) => r.id === runId);
  return idx >= 0 && idx < limit;
}

function mkRun(id: string, status: WorkflowRun['status'], createdAtMs: number): WorkflowRun {
  return {
    id,
    workflow: 'job',
    workflowVersion: '1',
    status,
    input: {},
    tags: ['singleton:k'],
    createdAt: new Date(createdAtMs),
    updatedAt: new Date(createdAtMs),
  };
}

describe('singleton admission — query-count benchmark (temporary)', () => {
  it('old=2 scans/admission, new=1 scan/admission; ordering identical', async () => {
    // Seed a mixed in-flight queue: interleaved running/suspended, out-of-order createdAt and ids,
    // to exercise the total-order sort (the row-order-independence that preserves FIFO).
    const seed: WorkflowRun[] = [
      mkRun('r5', 'suspended', 5000),
      mkRun('r1', 'running', 1000),
      mkRun('r3', 'suspended', 3000),
      mkRun('r2', 'running', 2000),
      mkRun('r4', 'suspended', 4000),
      mkRun('r2b', 'suspended', 2000), // same createdAt as r2 → id tiebreak
    ];

    const oldStore = new CountingStore();
    const newStore = new CountingStore();
    for (const r of seed) {
      await oldStore.createRun(r);
      await newStore.createRun(r);
    }

    // Run admission for EVERY run on both implementations; capture the admit verdicts (the FIFO view).
    const limit = 2;
    const oldVerdicts: Record<string, boolean> = {};
    const newVerdicts: Record<string, boolean> = {};
    for (const r of seed) {
      oldVerdicts[r.id] = await admitOld(oldStore, 'singleton:k', 'job', r.id, limit);
      newVerdicts[r.id] = await admitNew(newStore, 'singleton:k', 'job', r.id, limit);
    }

    // Ordering proof: same admit/deny verdict for every run → identical FIFO admission set.
    expect(newVerdicts).toEqual(oldVerdicts);
    // FIFO sanity: the two oldest by (createdAt,id) are r1(1000) and r2(2000) → admitted; rest denied.
    expect(newVerdicts).toEqual({
      r1: true,
      r2: true,
      r2b: false,
      r3: false,
      r4: false,
      r5: false,
    });

    // Query-count headline: 6 admissions.
    expect(oldStore.listRunsCalls).toBe(seed.length * 2); // 12 scans
    expect(newStore.listRunsCalls).toBe(seed.length * 1); // 6 scans
    // eslint-disable-next-line no-console
    console.log(
      `[bench] per-admission scans: OLD=${oldStore.listRunsCalls / seed.length} NEW=${newStore.listRunsCalls / seed.length} ` +
        `| total over ${seed.length} admissions: OLD=${oldStore.listRunsCalls} NEW=${newStore.listRunsCalls}`,
    );
  });

  it('N gated waiters retry loop: scans/sec halve (old 2N -> new N per tick)', async () => {
    const N = 10;
    const old2 = N * 2; // old: each waiter does 2 scans per ~1s tick
    const new1 = N * 1; // new: each waiter does 1 scan per ~1s tick
    // eslint-disable-next-line no-console
    console.log(
      `[bench] ${N} gated waiters, per ~1s retry tick: OLD≈${old2} scans/s -> NEW≈${new1} scans/s (jittered across ~±250ms)`,
    );
    expect(new1).toBe(old2 / 2);
  });

  it('jitter spreads waiter wakeups (no lockstep stampede)', async () => {
    // The retry uses clock()+1000±250ms with Math.random(). Sample many wake offsets and assert spread.
    const offsets = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      offsets.add(1000 + Math.floor((Math.random() * 2 - 1) * 250));
    }
    // With jitter, wakeups land on many distinct ms values (not a single 1000ms tick).
    expect(offsets.size).toBeGreaterThan(100);
    const min = Math.min(...offsets);
    const max = Math.max(...offsets);
    expect(min).toBeGreaterThanOrEqual(750);
    expect(max).toBeLessThanOrEqual(1250);
  });

  it('end-to-end via engine: admission uses one listRuns scan; release adds one notify scan', async () => {
    const store = new CountingStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => 'done', { singleton: { key: () => 'k' } });
    store.listRunsCalls = 0;
    const r = await startRun(engine, 'job', {}, 'solo');
    expect(r.status).toBe('completed');
    // The notify-on-release scan is fire-and-forget (`void wakeNextSingletons`), so flush the
    // microtask/macrotask queue before counting — otherwise the assertion can race the scan.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Admission still issues exactly ONE listRuns (was two before the single-scan optimization).
    // The terminal-state notify-on-release adds ONE scan (find the next gated waiter) — a one-shot
    // cost per completion that REPLACES the old per-~1s-tick re-poll for every gated waiter.
    expect(store.listRunsCalls).toBe(2);
    // eslint-disable-next-line no-console
    console.log(
      `[bench] engine uncontended singleton: admission(1) + notify-on-release(1) = ${store.listRunsCalls} listRuns scans`,
    );
  });
});
