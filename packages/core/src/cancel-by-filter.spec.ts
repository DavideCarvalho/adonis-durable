import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('cancelWhere — cancel runs matching a filter', () => {
  it('cancels only the runs matching the workflow + tag filter, leaving others untouched', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('order', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('other', '1', async (ctx) => ctx.waitForSignal('never'));

    await engine.start('order', {}, 'o1', { tags: ['vip'] });
    await engine.start('order', {}, 'o2', { tags: ['vip'] });
    await engine.start('order', {}, 'o3', { tags: ['normal'] });
    await engine.start('other', {}, 'x1', { tags: ['vip'] });
    for (const id of ['o1', 'o2', 'o3', 'x1']) await engine.waitForRun(id);

    const results = await engine.cancelWhere({ workflow: 'order', tag: 'vip' });

    expect(results.map((r) => r.runId).sort()).toEqual(['o1', 'o2']);
    expect(results.every((r) => r.status === 'cancelled')).toBe(true);
    expect((await store.getRun('o1'))?.status).toBe('cancelled');
    expect((await store.getRun('o2'))?.status).toBe('cancelled');
    expect((await store.getRun('o3'))?.status).toBe('suspended'); // wrong tag → untouched
    expect((await store.getRun('x1'))?.status).toBe('suspended'); // wrong workflow → untouched
  });

  it('matches by search attribute', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async (ctx) => ctx.waitForSignal('never'));

    await engine.start('job', {}, 'a', { searchAttributes: { tier: 'free' } });
    await engine.start('job', {}, 'b', { searchAttributes: { tier: 'pro' } });
    for (const id of ['a', 'b']) await engine.waitForRun(id);

    const results = await engine.cancelWhere({
      workflow: 'job',
      attributes: [{ key: 'tier', op: 'eq', value: 'free' }],
    });

    expect(results.map((r) => r.runId)).toEqual(['a']);
    expect((await store.getRun('a'))?.status).toBe('cancelled');
    expect((await store.getRun('b'))?.status).toBe('suspended');
  });

  it('does not re-cancel already-finished runs', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('quick', '1', async () => 'done');
    engine.register('held', '1', async (ctx) => ctx.waitForSignal('never'));

    await engine.start('quick', {}, 'done-1', { tags: ['batch'] });
    await engine.start('held', {}, 'held-1', { tags: ['batch'] });
    await engine.waitForRun('done-1');
    await engine.waitForRun('held-1');
    expect((await store.getRun('done-1'))?.status).toBe('completed');

    const results = await engine.cancelWhere({ tag: 'batch' });

    // The completed run reports its terminal status (cancel is a no-op on it); the held run cancels.
    const held = results.find((r) => r.runId === 'held-1');
    expect(held?.status).toBe('cancelled');
    expect((await store.getRun('done-1'))?.status).toBe('completed'); // untouched
  });

  it('forwards compensate to each matched run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const undone: string[] = [];
    engine.register('saga', '1', async (ctx) => {
      await ctx.step('reserve', async () => 1, {
        compensate: async () => void undone.push('reserve'),
      });
      await ctx.waitForSignal('never');
    });
    await engine.start('saga', {}, 's1', { tags: ['rollback'] });
    await engine.waitForRun('s1');

    await engine.cancelWhere({ tag: 'rollback' }, { compensate: true });

    for (let i = 0; i < 100 && (await store.getRun('s1'))?.status !== 'cancelled'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await store.getRun('s1'))?.status).toBe('cancelled');
    expect(undone).toEqual(['reserve']);
  });
});
