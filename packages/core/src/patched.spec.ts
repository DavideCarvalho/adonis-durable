import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('ctx.patched — in-place workflow migration', () => {
  it('new runs take the patched branch; a run recorded under old code keeps the old branch', async () => {
    const store = new InMemoryStateStore();

    // OLD deploy: reserve, charge, then wait (so the run is in flight, not yet completed).
    const oldEngine = new WorkflowEngine({ store });
    oldEngine.register('checkout', '1', async (ctx) => {
      await ctx.step('reserve', async () => 'r');
      await ctx.step('charge', async () => 'c');
      await ctx.waitForSignal('done');
      return 'old';
    });
    await startRun(oldEngine, 'checkout', {}, 'old-run');
    expect((await store.getRun('old-run'))?.status).toBe('suspended');

    // NEW deploy (same version, new engine instance on the same store): a fraud check guarded by a
    // patch, before reserve.
    const engine = new WorkflowEngine({ store });
    engine.register('checkout', '1', async (ctx) => {
      if (await ctx.patched('add-fraud-check')) {
        await ctx.step('fraud', async () => 'f');
      }
      await ctx.step('reserve', async () => 'r');
      await ctx.step('charge', async () => 'c');
      await ctx.waitForSignal('done');
      return 'new';
    });

    // The in-flight OLD run replays cleanly on the new code: it takes the OLD branch (no fraud step,
    // no patch marker) because its recorded history has a real step where the patch would sit.
    const replayed = await engine.resume('old-run');
    expect(replayed.status).toBe('suspended');
    expect((await store.listCheckpoints('old-run')).map((c) => c.name)).toEqual([
      'reserve',
      'charge',
    ]);

    // A brand-new run takes the patched branch and records the marker.
    await startRun(engine, 'checkout', {}, 'new-run');
    expect((await store.listCheckpoints('new-run')).map((c) => c.name)).toEqual([
      'patch:add-fraud-check',
      'fraud',
      'reserve',
      'charge',
    ]);
  });
});
