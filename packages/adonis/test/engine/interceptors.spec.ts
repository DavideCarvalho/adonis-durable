import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('step interceptors (engine.use)', () => {
  it('wraps each local step execution and can read its metadata + result', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const seen: Array<{ workflow: string; step: string; attempt: number; result: unknown }> = [];
    engine.use(async (inv, next) => {
      const result = await next();
      seen.push({ workflow: inv.workflow, step: inv.stepName, attempt: inv.attempt, result });
      return result;
    });

    engine.register('greet', '1', async (ctx, input) => {
      const name = await ctx.step('upper', async () => (input as { n: string }).n.toUpperCase());
      return `hi ${name}`;
    });
    const res = await startRun(engine, 'greet', { n: 'ada' }, 'r1');

    expect(res.output).toBe('hi ADA');
    expect(seen).toContainEqual({ workflow: 'greet', step: 'upper', attempt: 1, result: 'ADA' });
  });

  it('composes interceptors in onion order (first registered is outermost)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const order: string[] = [];
    engine.use(async (_inv, next) => {
      order.push('A:before');
      const r = await next();
      order.push('A:after');
      return r;
    });
    engine.use(async (_inv, next) => {
      order.push('B:before');
      const r = await next();
      order.push('B:after');
      return r;
    });
    engine.register('w', '1', async (ctx) => ctx.step('s', async () => 1));
    await startRun(engine, 'w', {}, 'r1');

    expect(order).toEqual(['A:before', 'B:before', 'B:after', 'A:after']);
  });

  it('does not fire on replay — only when a step actually executes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const fired: string[] = [];
    engine.use(async (inv, next) => {
      fired.push(inv.stepName);
      return next();
    });
    engine.register('w', '1', async (ctx) => {
      await ctx.step('a', async () => 'a');
      await ctx.waitForSignal('go');
      await ctx.step('b', async () => 'b');
      return 'done';
    });

    await startRun(engine, 'w', {}, 'r1');
    expect(fired).toEqual(['a']); // suspended at the signal; 'b' not reached yet

    await engine.signal('go', undefined);
    // resume replays 'a' (no execution → no fire) and runs 'b'
    expect(fired).toEqual(['a', 'b']);
  });

  it('use() returns an unsubscribe that removes the interceptor', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let count = 0;
    const off = engine.use(async (_inv, next) => {
      count += 1;
      return next();
    });
    engine.register('w', '1', async (ctx) => ctx.step('s', async () => 1));

    await startRun(engine, 'w', {}, 'r1');
    expect(count).toBe(1);
    off();
    await startRun(engine, 'w', {}, 'r2');
    expect(count).toBe(1); // unsubscribed — not called again
  });
});
