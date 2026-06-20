import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('engine.deleteRun', () => {
  it('hard-deletes a run and cascades to its whole subtree', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('parent', '1', async (ctx) => {
      await ctx.startChild('child', {}, 'ff-child'); // fire-and-forget
      await ctx.child('child', {}, 'awaited-child'); // awaited → parent suspends here
    });

    await engine.start('parent', {}, 'p1');
    await engine.waitForRun('p1');
    await engine.waitForRun('ff-child');
    await engine.waitForRun('awaited-child');

    const deleted = await engine.deleteRun('p1');

    // Parent + both children removed (returns the count), and they no longer exist.
    expect(deleted).toBe(3);
    expect(await store.getRun('p1')).toBeNull();
    expect(await store.getRun('ff-child')).toBeNull();
    expect(await store.getRun('awaited-child')).toBeNull();
    // The parent's checkpoints went with it.
    expect(await store.listCheckpoints('p1')).toEqual([]);
  });

  it('is a no-op (returns 0) for a missing run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    expect(await engine.deleteRun('nope')).toBe(0);
  });
});
