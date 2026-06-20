import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('engine.update — validated request/response to a running run', () => {
  it('rejects via the validator without disturbing the run, then accepts a valid update', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('order', '1', async (ctx) => {
      const d = await ctx.onUpdate<{ approved: boolean; by?: string }>('approve');
      return d.approved ? `approved by ${d.by}` : 'rejected';
    });
    engine.registerUpdateValidator('order', 'approve', (arg: { by?: string }) => {
      if (!arg?.by) throw new Error('approver is required');
    });

    await startRun(engine, 'order', {}, 'r1'); // suspends on the update point

    const bad = await engine.update('r1', 'approve', { approved: true });
    expect(bad.accepted).toBe(false);
    if (!bad.accepted) expect(bad.reason).toBe('approver is required');
    expect((await store.getRun('r1'))?.status).toBe('suspended'); // untouched

    const ok = await engine.update('r1', 'approve', { approved: true, by: 'alice' });
    expect(ok.accepted).toBe(true);
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect((await store.getRun('r1'))?.output).toBe('approved by alice');
  });

  it('accepts when no validator is registered for the update', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => ctx.onUpdate<number>('bump'));
    await startRun(engine, 'wf', {}, 'r1');

    const res = await engine.update('r1', 'bump', 42);
    expect(res.accepted).toBe(true);
    expect((await store.getRun('r1'))?.output).toBe(42);
  });
});
