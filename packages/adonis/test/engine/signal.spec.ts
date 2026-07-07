import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — signals (human-in-the-loop)', () => {
  it('suspends on waitForSignal and resumes with the payload when the signal arrives', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const order: string[] = [];
    engine.register('approval', '1', async (ctx) => {
      await ctx.localStep('request', async () => {
        order.push('request');
      });
      const decision = await ctx.waitForSignal<{ approved: boolean }>('approve-42');
      await ctx.localStep('act', async () => {
        order.push(decision.approved ? 'approved' : 'rejected');
      });
      return decision.approved;
    });

    const started = await startRun(engine, 'approval', {}, 'run1');
    expect(started.status).toBe('suspended');
    expect(order).toEqual(['request']);

    const resumed = await engine.signal('approve-42', { approved: true });
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toBe(true);
    expect(order).toEqual(['request', 'approved']);
  });
});
