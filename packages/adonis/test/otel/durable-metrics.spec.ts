import { describe, expect, it } from 'vitest';
import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import { attachDurableMetrics } from '../../src/otel/durable-metrics.js';

describe('attachDurableMetrics', () => {
  it('counts runs/steps and records duration percentiles', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      await ctx.localStep('b', async () => 2);
      return 'done';
    });
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const snap = metrics.snapshot();
    expect(snap.runs.started).toBe(1);
    expect(snap.runs.completed).toBe(1);
    expect(snap.steps.completed).toBe(2);
    expect(snap.stepDurationMs.count).toBe(2);
    expect(snap.runDurationMs.count).toBe(1);

    metrics.reset();
    expect(metrics.snapshot().runs.started).toBe(0);
    metrics.unsubscribe();
  });

  it('counts a failed run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);
    engine.register('boom', '1', async (ctx) =>
      ctx.localStep('x', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('boom', {}, 'run2');
    await engine.waitForRun('run2');
    const snap = metrics.snapshot();
    expect(snap.runs.failed).toBe(1);
    expect(snap.steps.failed).toBe(1);
  });
});
