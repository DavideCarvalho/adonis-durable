import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '@agora/durable-core';
import { describe, expect, it } from 'vitest';
import { resolveStore } from '../src/resolve_store.js';
import { listRuns, renderRunsTable, retryRun } from '../src/runs.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  engine.register('checkout', '1', async (ctx) => {
    await ctx.step('reserve', async () => 1);
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

describe('resolveStore', () => {
  it('returns the configured store', () => {
    const store = new InMemoryStateStore();
    const app = { config: { get: <T>(_k: string, _d?: T) => ({ store }) as unknown as T } };
    expect(resolveStore(app)).toBe(store);
  });

  it('returns undefined when no store is configured', () => {
    const app = { config: { get: <T>(_k: string, d?: T) => (d ?? {}) as T } };
    expect(resolveStore(app)).toBeUndefined();
  });
});
