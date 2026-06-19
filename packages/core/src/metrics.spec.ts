import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { collectMetrics } from './metrics.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('collectMetrics', () => {
  it('counts run/step outcomes and per-workflow runs from engine events', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);

    engine.register('ok', '1', async (ctx) => {
      await ctx.step('a', async () => 1);
      return 'done';
    });
    engine.register('bad', '1', async () => {
      throw new Error('boom');
    });

    await startRun(engine, 'ok', {}, 'r1');
    await startRun(engine, 'bad', {}, 'r2');

    const s = metrics.snapshot();
    expect(s.runs.started).toBe(2);
    expect(s.runs.completed).toBe(1);
    expect(s.runs.failed).toBe(1);
    expect(s.steps.completed).toBe(1);
    expect(s.byWorkflow.ok).toEqual({ started: 1, completed: 1, failed: 0 });
    expect(s.byWorkflow.bad?.failed).toBe(1);

    const prom = metrics.prometheus();
    expect(prom).toContain('durable_runs_total{event="completed"} 1');
    expect(prom).toContain('durable_runs_by_workflow_total{workflow="ok",event="completed"} 1');

    metrics.stop();
  });
});
