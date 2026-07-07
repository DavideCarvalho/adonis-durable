import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — step events (observability)', () => {
  it('checkpoints debug/error lines and sub-process outcomes a local step emits', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('processing', async (log) => {
        log.info('planned 3 sub-processes');
        log.sub('proc-a', 'ok');
        log.sub('proc-b', 'failed', 'validation rejected');
        log.sub('proc-c', 'skipped');
        log.debug('done', { count: 3 });
        return 'ok';
      });
      return 'ok';
    });

    await startRun(engine, 'wf', {}, 'run1');

    const cp = await store.getCheckpoint('run1', 0);
    expect(cp?.events).toHaveLength(5);
    const sub = cp?.events?.filter((e) => e.status);
    expect(sub?.map((e) => [e.name, e.status, e.level])).toEqual([
      ['proc-a', 'ok', 'info'],
      ['proc-b', 'failed', 'error'],
      ['proc-c', 'skipped', 'warn'],
    ]);
    expect(cp?.events?.[4]).toMatchObject({ level: 'debug', message: 'done', data: { count: 3 } });
  });

  it('keeps events from the failing attempt when a step throws terminally', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('boom', async (log) => {
        log.error('about to fail');
        throw new Error('kaput');
      });
      return 'ok';
    });

    await startRun(engine, 'wf', {}, 'run1');

    const cp = await store.getCheckpoint('run1', 0);
    expect(cp?.status).toBe('failed');
    expect(cp?.events).toEqual([
      expect.objectContaining({ level: 'error', message: 'about to fail' }),
    ]);
  });

  it('leaves events undefined when a step logs nothing', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('quiet', async () => 1);
      return 'ok';
    });

    await startRun(engine, 'wf', {}, 'run1');

    expect((await store.getCheckpoint('run1', 0))?.events).toBeUndefined();
  });
});
