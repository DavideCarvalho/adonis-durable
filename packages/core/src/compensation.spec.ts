import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import type { EngineEvent } from './interfaces.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('saga compensation — retry + visibility', () => {
  it('retries a transient compensation and emits a compensate:<step> completion', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, compensationRetries: 3 });
    const seen: Array<{ type: string; name?: string }> = [];
    engine.subscribe((e: EngineEvent) => {
      if (e.name?.startsWith('compensate:')) seen.push({ type: e.type, name: e.name });
    });

    let undoAttempts = 0;
    engine.register('saga', '1', async (ctx) => {
      await ctx.step('reserve', async () => 'r', {
        compensate: async () => {
          undoAttempts += 1;
          if (undoAttempts < 2) throw new Error('refund hiccup');
        },
      });
      await ctx.step('charge', async () => {
        throw new Error('declined');
      });
      return 'done';
    });

    const result = await startRun(engine, 'saga', {}, 'r1');
    expect(result.status).toBe('failed');
    expect(undoAttempts).toBe(2); // first attempt threw, retry succeeded
    expect(seen).toEqual([{ type: 'step.completed', name: 'compensate:reserve' }]);
  });

  it('emits a compensate:<step> failure when an undo never succeeds (not silently swallowed)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, compensationRetries: 2 });
    const failures: string[] = [];
    engine.subscribe((e: EngineEvent) => {
      if (e.type === 'step.failed' && e.name?.startsWith('compensate:')) failures.push(e.name);
    });

    engine.register('saga', '1', async (ctx) => {
      await ctx.step('reserve', async () => 'r', {
        compensate: async () => {
          throw new Error('refund permanently down');
        },
      });
      await ctx.step('charge', async () => {
        throw new Error('declined');
      });
      return 'done';
    });

    const result = await startRun(engine, 'saga', {}, 'r1');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('declined'); // original failure preserved, not masked
    expect(failures).toEqual(['compensate:reserve']);
  });
});
