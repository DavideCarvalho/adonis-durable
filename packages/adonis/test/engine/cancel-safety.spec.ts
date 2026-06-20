import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — cancelled runs are not resurrected', () => {
  it('resume() is a no-op on a cancelled run (a late event cannot re-run it)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let ran = 0;
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('after-signal', async () => {
        ran += 1;
      });
      return 'ok';
    });

    // Suspend on a signal, cancel, then a late resume must not execute the body.
    engine.register('wf', '1', async (ctx) => {
      ran += 1;
      await ctx.waitForSignal('go');
    });
    await engine.start('wf', {}, 'run1');
    await engine.cancel('run1');
    const before = ran;

    const result = await engine.resume('run1');
    expect(result.status).toBe('cancelled');
    expect(ran).toBe(before); // body did NOT re-run
  });
});
