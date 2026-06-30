import { describe, expect, it } from 'vitest';
import { NamespaceMismatch, WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('engine namespace partitioning (run-scoping core)', () => {
  it('stamps created runs with the engine namespace', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} }, // no-op: leave it pending so we can inspect the row
      namespace: 'alpha',
    });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {}, 'run-stamp-1');
    expect(runId).toBe('run-stamp-1');
    expect((await store.getRun('run-stamp-1'))?.namespace).toBe('alpha');
  });

  it('defaults to "default" when no namespace is configured (back-compat)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {}, 'run-default-1');
    expect(runId).toBe('run-default-1');
    expect((await store.getRun('run-default-1'))?.namespace).toBe('default');
  });

  it('two engines sharing ONE store only poll their own namespace runs', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'mine',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'alpha',
      createdAt: now,
      updatedAt: now,
    });
    await store.createRun({
      id: 'theirs',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'beta',
      createdAt: now,
      updatedAt: now,
    });

    const ranAlpha: string[] = [];
    const ranBeta: string[] = [];
    const alpha = new WorkflowEngine({ store, namespace: 'alpha' });
    const beta = new WorkflowEngine({ store, namespace: 'beta' });
    alpha.register('w', '1', async (ctx) => {
      ranAlpha.push(ctx.runId);
      return 'ok';
    });
    beta.register('w', '1', async (ctx) => {
      ranBeta.push(ctx.runId);
      return 'ok';
    });

    await alpha.runPending();
    await delay(20); // let the dispatched run settle

    expect(ranAlpha).toEqual(['mine']);
    expect(ranBeta).toEqual([]);
    expect((await store.getRun('theirs'))?.status).toBe('pending'); // untouched by the alpha worker
  });

  it('runOne skips (and does not run) a run whose namespace differs from the engine', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'foreign',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'beta',
      createdAt: now,
      updatedAt: now,
    });
    const ran: string[] = [];
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      namespace: 'alpha',
    });
    engine.register('w', '1', async (ctx) => {
      ran.push(ctx.runId);
      return 'ok';
    });

    const result = await engine.runOne('foreign');

    expect(result).toBeNull();
    expect(ran).toEqual([]);
    // Not executed; the lease was released so the owning pool can still pick it up.
    const after = await store.getRun('foreign');
    expect(after?.status).toBe('pending');
    expect(after?.lockedBy).toBeUndefined();
  });

  it('resume() of a cross-namespace run throws NamespaceMismatch and releases the lock', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'foreign',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'beta',
      createdAt: now,
      updatedAt: now,
    });
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      namespace: 'alpha',
    });
    engine.register('w', '1', async () => 'ok');

    await expect(engine.resume('foreign')).rejects.toBeInstanceOf(NamespaceMismatch);
    expect((await store.getRun('foreign'))?.lockedBy).toBeUndefined();
  });

  it('RUNS a run with an undefined namespace (back-compat for un-migrated stores)', async () => {
    // Simulate a pre-namespace store row by stripping the namespace on read for one run id.
    class LegacyStore extends InMemoryStateStore {
      override async getRun(runId: string): Promise<WorkflowRun | null> {
        const run = await super.getRun(runId);
        if (run?.id === 'legacy') return { ...run, namespace: undefined };
        return run;
      }
    }

    const store = new LegacyStore();
    const now = new Date();
    await store.createRun({
      id: 'legacy',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: undefined,
      createdAt: now,
      updatedAt: now,
    });

    const ran: string[] = [];
    const engine = new WorkflowEngine({ store, namespace: 'alpha' });
    engine.register('w', '1', async (ctx) => {
      ran.push(ctx.runId);
      return 'ok';
    });

    await engine.runOne('legacy');
    await delay(20);
    expect(ran).toEqual(['legacy']); // undefined namespace is NOT skipped
  });

  it('default-namespace engine behavior is unchanged (a plain run completes)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('w', '1', async () => 'done');
    await engine.start('w', {}, 'r1');
    const result = await engine.waitForRun('r1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
    expect((await store.getRun('r1'))?.namespace).toBe('default');
  });
});

describe('InMemoryStateStore namespace filtering', () => {
  const now = new Date('2026-06-26T00:00:00.000Z');
  const base = { workflow: 'w', workflowVersion: '1', input: {}, createdAt: now, updatedAt: now };

  it('listPendingRuns filters by namespace, and no-arg returns all (back-compat)', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'a', status: 'pending', namespace: 'alpha' });
    await store.createRun({ ...base, id: 'b', status: 'pending', namespace: 'beta' });
    await store.createRun({ ...base, id: 'c', status: 'pending' }); // legacy → normalized to 'default'

    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect((await store.listPendingRuns(10, 'default')).map((r) => r.id)).toEqual(['c']);
  });

  it('listIncompleteRuns and listDueTimers filter by namespace', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'r', status: 'running', namespace: 'alpha' });
    await store.createRun({ ...base, id: 's', status: 'running', namespace: 'beta' });
    await store.createRun({
      ...base,
      id: 't',
      status: 'suspended',
      namespace: 'alpha',
      wakeAt: now.getTime() - 1,
    });
    await store.createRun({
      ...base,
      id: 'u',
      status: 'suspended',
      namespace: 'beta',
      wakeAt: now.getTime() - 1,
    });

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(now.getTime(), 'alpha')).map((r) => r.id)).toEqual(['t']);
  });

  it('listRuns filters by namespace (read surface opt-in)', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'a', status: 'running', namespace: 'alpha' });
    await store.createRun({ ...base, id: 'b', status: 'running', namespace: 'beta' });

    expect((await store.listRuns({ namespace: 'alpha' })).map((r) => r.id)).toEqual(['a']);
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});
