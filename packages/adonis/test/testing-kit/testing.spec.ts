import {
  assertOutput,
  assertRunStatus,
  assertStepAttempts,
  assertStepsRan,
  createTestEngine,
  failOnce,
} from '../../src/testing-kit/index.js';

describe('createTestEngine', () => {
  it('runs a workflow and exposes store/clock for assertions', async () => {
    const t = createTestEngine();
    t.engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      return 'ok';
    });
    const result = await t.run('wf', {}, 'run1');

    expect(result.status).toBe('completed');
    await assertRunStatus(t.store, 'run1', 'completed');
    await assertOutput(t.store, 'run1', 'ok');
    await assertStepsRan(t.store, 'run1', ['a']);
  });

  it('tick advances the clock and resumes a durable sleep', async () => {
    const t = createTestEngine();
    const order: string[] = [];
    t.engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('before', async () => order.push('before'));
      await ctx.sleep('10s');
      await ctx.localStep('after', async () => order.push('after'));
    });

    const started = await t.run('wf', {}, 'run1');
    expect(started.status).toBe('suspended');

    await t.tick(4_000); // not due
    await assertRunStatus(t.store, 'run1', 'suspended');

    await t.tick(7_000); // now past 10s total
    await assertRunStatus(t.store, 'run1', 'completed');
    expect(order).toEqual(['before', 'after']);
  });
});

describe('crash/flaky injection', () => {
  it('failOnce makes a step throw once, then succeed (drives retry/resume)', async () => {
    const t = createTestEngine();
    t.engine.register('wf', '1', async (ctx) =>
      ctx.localStep('flaky', failOnce('done'), { retries: 2 }),
    );

    const result = await t.run('wf', {}, 'run1');
    expect(result.status).toBe('completed');
    await assertStepAttempts(t.store, 'run1', 'flaky', 2);
  });
});

describe('assertions fail loudly', () => {
  it('throws a clear error on a wrong status', async () => {
    const t = createTestEngine();
    t.engine.register('wf', '1', async () => 'ok');
    await t.run('wf', {}, 'run1');
    await expect(assertRunStatus(t.store, 'run1', 'failed')).rejects.toThrow(/completed/);
  });
});
