import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('WorkflowEngine — retry backoff', () => {
  it('waits the configured exponential backoff between attempts', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    // Capture the delays the engine waits, and fire them immediately so the test is fast.
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);

    let attempts = 0;
    engine.register('wf', '1', async (ctx) => {
      await ctx.step(
        'flaky',
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('blip');
          return 'ok';
        },
        { retries: 3, backoff: 'exp', backoffMs: 100 },
      );
    });

    const result = await startRun(engine, 'wf', {}, 'run1');
    vi.unstubAllGlobals();

    expect(result.status).toBe('completed');
    expect(attempts).toBe(3);
    // exp backoff from 100ms: attempt 1 → 100, attempt 2 → 200.
    expect(delays).toEqual([100, 200]);
  });

  it('does not wait when no backoff is configured', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);

    let attempts = 0;
    engine.register('wf', '1', async (ctx) => {
      await ctx.step(
        'flaky',
        async () => {
          attempts += 1;
          if (attempts < 2) throw new Error('blip');
          return 'ok';
        },
        { retries: 2 },
      );
    });
    await startRun(engine, 'wf', {}, 'run1');
    vi.unstubAllGlobals();

    expect(attempts).toBe(2);
    expect(delays).toEqual([]); // no setTimeout-based wait
  });
});
