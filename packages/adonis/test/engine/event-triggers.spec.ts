import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('event triggers (onEvent starts a workflow)', () => {
  it('starts a subscribed workflow when its event is published, with the payload as input', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'send-welcome',
      '1',
      async (_ctx, input) => `welcome ${(input as { email: string }).email}`,
      { onEvent: ['user.registered'] },
    );

    const affected = await engine.publishEvent(
      'user.registered',
      { email: 'a@b.com' },
      { id: 'u1' },
    );
    expect(affected).toBe(1);

    await engine.waitForRun('evt:u1:send-welcome');
    const run = await store.getRun('evt:u1:send-welcome');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('welcome a@b.com');
  });

  it('triggers on any event name in the array', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('audit', '1', async (_ctx, input) => (input as { kind: string }).kind, {
      onEvent: ['user.registered', 'user.deleted'],
    });

    await engine.publishEvent('user.deleted', { kind: 'gone' }, { id: 'd1' });
    await engine.waitForRun('evt:d1:audit');
    expect((await store.getRun('evt:d1:audit'))?.output).toBe('gone');
  });

  it('is idempotent: redelivering the same event id does not start a second run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let starts = 0;
    engine.register(
      'count',
      '1',
      async (ctx) => {
        await ctx.step('enter', async () => {
          starts += 1;
        });
        return starts;
      },
      { onEvent: ['ping'] },
    );

    await engine.publishEvent('ping', {}, { id: 'p1' });
    await engine.waitForRun('evt:p1:count');
    await engine.publishEvent('ping', {}, { id: 'p1' });
    expect(starts).toBe(1);
    expect((await store.listRuns({ workflow: 'count' })).length).toBe(1);
  });

  it('resumes waiters AND starts triggers from one publish, counting both', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('waiter', '1', async (ctx) => {
      const p = await ctx.waitForEvent<{ v: number }>('thing.happened');
      return p.v;
    });
    engine.register('trigger', '1', async (_ctx, input) => (input as { v: number }).v * 10, {
      onEvent: ['thing.happened'],
    });

    await startRun(engine, 'waiter', {}, 'w1');
    expect((await store.getRun('w1'))?.status).toBe('suspended');

    const affected = await engine.publishEvent('thing.happened', { v: 3 }, { id: 'e1' });
    expect(affected).toBe(2); // 1 waiter resumed + 1 trigger started
    expect((await store.getRun('w1'))?.output).toBe(3);
    await engine.waitForRun('evt:e1:trigger');
    expect((await store.getRun('evt:e1:trigger'))?.output).toBe(30);
  });
});
