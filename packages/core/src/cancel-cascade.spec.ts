import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('cancellation propagation to children', () => {
  it('cancels both awaited (ctx.child) and fire-and-forget (ctx.startChild) children', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('parent', '1', async (ctx) => {
      await ctx.startChild('child', {}, 'ff-child'); // fire-and-forget
      await ctx.child('child', {}, 'awaited-child'); // awaited → parent suspends here
    });

    await engine.start('parent', {}, 'p1');
    await engine.waitForRun('p1'); // parent suspended on the awaited child
    await engine.waitForRun('ff-child');
    await engine.waitForRun('awaited-child');
    expect((await store.getRun('ff-child'))?.status).toBe('suspended');
    expect((await store.getRun('awaited-child'))?.status).toBe('suspended');

    await engine.cancel('p1');

    expect((await store.getRun('p1'))?.status).toBe('cancelled');
    expect((await store.getRun('ff-child'))?.status).toBe('cancelled'); // cascaded
    expect((await store.getRun('awaited-child'))?.status).toBe('cancelled'); // cascaded
  });

  it('does not clobber a child that already finished', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('quick', '1', async () => 'done');
    engine.register('parent', '1', async (ctx) => {
      await ctx.startChild('quick', {}, 'done-child');
      await ctx.waitForSignal('hold'); // keep the parent alive
    });

    await engine.start('parent', {}, 'p1');
    await engine.waitForRun('p1');
    await engine.waitForRun('done-child');
    expect((await store.getRun('done-child'))?.status).toBe('completed');

    await engine.cancel('p1');
    expect((await store.getRun('p1'))?.status).toBe('cancelled');
    expect((await store.getRun('done-child'))?.status).toBe('completed'); // untouched
  });
});
