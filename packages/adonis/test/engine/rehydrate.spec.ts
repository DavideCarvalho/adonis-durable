import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('local step context re-hydration (engine.rehydrate)', () => {
  it('invokes the rehydrate hook around the local step body with the run carrier', async () => {
    const store = new InMemoryStateStore();
    let seenCarrier: Record<string, unknown> | undefined = { sentinel: true };
    let ran = false;
    const engine = new WorkflowEngine({
      store,
      // Symmetric with the dispatch carrier: read at step-execution time.
      context: () => ({ tenantId: 't1', userRef: { type: 'User', id: 7 } }),
      rehydrate: (carrier, fn) => {
        seenCarrier = carrier;
        return fn();
      },
    });
    engine.register('w', '1', async (ctx) =>
      ctx.step('s', async () => {
        ran = true;
        return 42;
      }),
    );

    const res = await startRun(engine, 'w', {}, 'r1');

    expect(res.output).toBe(42); // step result unaffected by the wrap
    expect(ran).toBe(true);
    expect(seenCarrier).toEqual({ tenantId: 't1', userRef: { type: 'User', id: 7 } });
  });

  it('passes an undefined carrier when no context reader is configured', async () => {
    const store = new InMemoryStateStore();
    let calls = 0;
    let seenCarrier: Record<string, unknown> | undefined = { sentinel: true };
    const engine = new WorkflowEngine({
      store,
      rehydrate: (carrier, fn) => {
        calls += 1;
        seenCarrier = carrier;
        return fn();
      },
    });
    engine.register('w', '1', async (ctx) => ctx.step('s', async () => 'ok'));

    const res = await startRun(engine, 'w', {}, 'r1');

    expect(res.output).toBe('ok');
    expect(calls).toBe(1);
    expect(seenCarrier).toBeUndefined();
  });

  it('default passthrough when rehydrate is unset — behavior byte-identical', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('w', '1', async (ctx) => {
      const a = await ctx.step('a', async () => 1);
      const b = await ctx.step('b', async () => a + 1);
      return b;
    });

    const res = await startRun(engine, 'w', {}, 'r1');
    expect(res.output).toBe(2);
  });
});
