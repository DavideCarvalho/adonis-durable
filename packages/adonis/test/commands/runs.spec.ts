import { describe, expect, it } from 'vitest';
import { listRuns, renderRunsTable, retryRun } from '../../src/commands/runs.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  engine.register('checkout', '1', async (ctx) => {
    await ctx.localStep('reserve', async () => 1);
    return 'ok';
  });
  return { store, engine };
}

describe('listRuns / renderRunsTable', () => {
  it('lists completed runs and renders a table', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const runs = await listRuns(store, {});
    expect(runs.map((r) => r.id)).toContain('run1');

    const table = renderRunsTable(runs);
    expect(table).toContain('WORKFLOW');
    expect(table).toContain('checkout');
    expect(table).toContain('completed');
  });

  it('filters by status', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    expect(await listRuns(store, { status: 'completed' })).toHaveLength(1);
    expect(await listRuns(store, { status: 'failed' })).toHaveLength(0);
  });

  it('says when there are no runs', () => {
    expect(renderRunsTable([])).toMatch(/no runs/i);
  });
});

describe('retryRun', () => {
  it('re-enqueues an existing run to pending', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const result = await retryRun(engine, 'run1');
    expect(result).not.toBeNull();
    expect(result?.runId).toBe('run1');
    // requeue returns the enqueued state immediately; the in-process dispatcher then picks it up, so
    // the run leaves the terminal `completed` state and re-executes.
    expect(result?.status).toBe('pending');
    await engine.waitForRun('run1');
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
  });

  it('returns null for an unknown run', async () => {
    const { engine } = makeEngine();
    expect(await retryRun(engine, 'nope')).toBeNull();
  });
});

describe('listRuns via the engine read API', () => {
  it('lists runs through engine.listRuns (same surface the command uses)', async () => {
    const { engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');
    const runs = await listRuns(engine, { limit: 10 });
    expect(runs.map((r) => r.id)).toContain('run1');
  });
});
