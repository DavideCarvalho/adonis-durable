import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { SignalTimeoutError } from './errors.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('waitForSignal timeout', () => {
  it('throws SignalTimeoutError when the deadline passes before the signal', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    let caught = false;
    engine.register('approve', '1', async (ctx) => {
      try {
        await ctx.waitForSignal('go', { timeoutMs: 5000 });
        return 'approved';
      } catch (e) {
        if (e instanceof SignalTimeoutError) {
          caught = true;
          return 'timed-out';
        }
        throw e;
      }
    });

    const first = await startRun(engine, 'approve', {}, 'r1');
    expect(first.status).toBe('suspended');

    now = 7000; // past the 6000ms deadline
    await engine.resumeDueTimers(now);

    expect(caught).toBe(true);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('timed-out');
  });

  it('returns the payload when the signal beats the deadline', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('approve', '1', async (ctx) =>
      ctx.waitForSignal<{ ok: boolean }>('go', { timeoutMs: 5000 }),
    );

    await startRun(engine, 'approve', {}, 'r2');
    now = 2000; // before the deadline
    const resumed = await engine.signal('go', { ok: true });
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toEqual({ ok: true });
  });
});
