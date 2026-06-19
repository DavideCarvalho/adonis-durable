import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('WorkflowEngine — breakpoints', () => {
  it('pauses at a breakpoint and resumes from engine.continue()', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const order: string[] = [];
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('before', async () => void order.push('before'));
      await ctx.breakpoint('after-extraction');
      await ctx.step('after', async () => void order.push('after'));
      return 'done';
    });

    const started = await startRun(engine, 'wf', {}, 'run1');
    expect(started.status).toBe('suspended');
    expect(order).toEqual(['before']);

    // The breakpoint shows up as a visible pending checkpoint in the timeline.
    const bp = (await store.listCheckpoints('run1')).find((c) => c.status === 'pending');
    expect(bp).toMatchObject({
      kind: 'signal',
      name: 'breakpoint:after-extraction',
      status: 'pending',
    });

    const resumed = await engine.continue('run1');
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toBe('done');
    expect(order).toEqual(['before', 'after']);
    // No pending checkpoint lingers once continued.
    expect((await store.listCheckpoints('run1')).some((c) => c.status === 'pending')).toBe(false);
  });

  it('continue() is a no-op (null) for a run not paused at a breakpoint', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'ok');
    await startRun(engine, 'wf', {}, 'run1');
    expect(await engine.continue('run1')).toBeNull();
  });
});
