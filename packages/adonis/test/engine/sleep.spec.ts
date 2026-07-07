import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — durable sleep', () => {
  it('suspends on sleep and resumes once the timer is due, without re-running prior steps', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now });

    const order: string[] = [];
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('before', async () => {
        order.push('before');
      });
      await ctx.sleep('10s');
      await ctx.localStep('after', async () => {
        order.push('after');
      });
      return 'done';
    });

    const started = await startRun(engine, 'wf', {}, 'run1');
    expect(started.status).toBe('suspended');
    expect(order).toEqual(['before']);

    // Not due yet (+4s of a 10s sleep): stays suspended, 'after' must not run.
    now = 5_000;
    await engine.resumeDueTimers(now);
    expect((await store.getRun('run1'))?.status).toBe('suspended');
    expect(order).toEqual(['before']);

    // Due (+11s): resumes, replays 'before' from checkpoint, runs 'after', completes.
    now = 12_000;
    await engine.resumeDueTimers(now);
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('done');
    expect(order).toEqual(['before', 'after']);
  });
});
