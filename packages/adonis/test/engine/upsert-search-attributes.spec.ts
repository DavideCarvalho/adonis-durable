import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('ctx.upsertSearchAttributes', () => {
  it('shallow-merges into the run searchAttributes and records a checkpoint per call', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('tag', '1', async (ctx) => {
      await ctx.upsertSearchAttributes({ a: 1 });
      await ctx.upsertSearchAttributes({ b: 'two', c: true });
      return 'done';
    });

    await startRun(engine, 'tag', {}, 'r1');
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.searchAttributes).toEqual({ a: 1, b: 'two', c: true }); // shallow merge across calls
    const recorded = (await store.listCheckpoints('r1')).filter(
      (c) => c.name === 'searchAttributes',
    );
    expect(recorded).toHaveLength(2); // one durable marker per upsert
  });

  it('writes exactly once across replays — the merge is skipped on resume', async () => {
    const store = new InMemoryStateStore();
    let saWrites = 0;
    const origUpdate = store.updateRun.bind(store);
    // Count only searchAttributes writes (status/lease updates don't carry the field).
    store.updateRun = (id, patch) => {
      if (patch.searchAttributes !== undefined) saWrites += 1;
      return origUpdate(id, patch);
    };
    const engine = new WorkflowEngine({ store });
    engine.register('tag', '1', async (ctx) => {
      await ctx.upsertSearchAttributes({ a: 1 });
      await ctx.waitForSignal('go-r1'); // suspends after the upsert, forcing a second turn (replay)
      return 'done';
    });

    await startRun(engine, 'tag', {}, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('suspended');
    expect(saWrites).toBe(1); // applied on the first turn

    await engine.signal('go-r1', undefined); // resume replays the body — the upsert is a no-op now
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(saWrites).toBe(1); // NOT re-written on replay
    expect((await store.getRun('r1'))?.searchAttributes).toEqual({ a: 1 });
  });

  it('preserves existing searchAttributes set at start (merge, not replace)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('tag', '1', async (ctx) => {
      await ctx.upsertSearchAttributes({ added: 'x' });
      return 'done';
    });

    await startRun(engine, 'tag', {}, 'r1', { searchAttributes: { initial: 1 } });
    expect((await store.getRun('r1'))?.searchAttributes).toEqual({ initial: 1, added: 'x' });
  });
});
