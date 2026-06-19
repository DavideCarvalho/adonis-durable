import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('engine.cancel({ compensate: true }) — undo on cancellation', () => {
  it('runs saga compensations in reverse, then marks the run cancelled', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const undone: string[] = [];

    engine.register('saga', '1', async (ctx) => {
      await ctx.step('reserve', async () => 'r', {
        compensate: async () => {
          undone.push('reserve');
        },
      });
      await ctx.step('pack', async () => 'p', {
        compensate: async () => {
          undone.push('pack');
        },
      });
      await ctx.waitForSignal('ship'); // run suspends here, mid-saga
      return 'done';
    });

    await startRun(engine, 'saga', {}, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    // Compensate-cancel returns immediately (non-blocking) and runs the undo in the background.
    await engine.cancel('r1', { compensate: true });
    for (let i = 0; i < 100 && (await store.getRun('r1'))?.status !== 'cancelled'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(undone).toEqual(['pack', 'reserve']); // reverse order
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
  });

  it('plain cancel() leaves completed steps untouched (no compensation)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let undos = 0;
    engine.register('saga', '1', async (ctx) => {
      await ctx.step('reserve', async () => 'r', {
        compensate: async () => {
          undos += 1;
        },
      });
      await ctx.waitForSignal('ship');
      return 'done';
    });
    await startRun(engine, 'saga', {}, 'r1');

    const res = await engine.cancel('r1');
    expect(res?.status).toBe('cancelled');
    expect(undos).toBe(0);
  });
});
