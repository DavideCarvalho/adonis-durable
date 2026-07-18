import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A run that SUSPENDS waiting on an event (a signal, a child's completion, a timeout-less remote step)
 * gets no natural `wakeAt`. If the wake is ever lost (the delivering pod crashes/rolls mid-handoff) the
 * run would sit `suspended` with `wakeAt: null` forever — invisible to the timer poller AND to
 * crash-recovery. `reconcileMs` stamps a fallback `wakeAt` so `resumeDueTimers` re-drives it (an
 * idempotent replay). Regression cover for the singleton-deadlock that fell out of this.
 */
describe('WorkflowEngine — reconcile fallback for event-waiting suspends', () => {
  it('stamps a fallback wakeAt on a signal-wait suspend, so a lost wake is recoverable by the timer poller', async () => {
    const store = new InMemoryStateStore();
    const now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now, reconcileMs: 300_000 });

    engine.register('approval', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'done';
    });

    const started = await startRun(engine, 'approval', {}, 'run1');
    expect(started.status).toBe('suspended');
    // BEFORE the fix this was undefined → invisible to resumeDueTimers → orphaned forever.
    expect((await store.getRun('run1'))?.wakeAt).toBe(now + 300_000);
    // The orphan-prone run is now in the due-timers set once the window elapses.
    const due = await store.listDueTimers(now + 300_001, undefined);
    expect(due.map((r) => r.id)).toContain('run1');
  });

  it('a reconcile re-drive is an idempotent replay: a still-waiting run re-suspends (prior step runs once), then the real signal still completes it', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now, reconcileMs: 60_000 });

    const ran: string[] = [];
    engine.register('approval', '1', async (ctx) => {
      await ctx.localStep('side', async () => {
        ran.push('side');
      });
      await ctx.waitForSignal('go');
      return 'done';
    });

    await startRun(engine, 'approval', {}, 'run1');
    expect(ran).toEqual(['side']);

    // Fallback fires but the signal hasn't arrived: re-drive replays → re-suspends, side-effect NOT re-run.
    now = 61_001;
    await engine.resumeDueTimers(now);
    expect((await store.getRun('run1'))?.status).toBe('suspended');
    expect(ran).toEqual(['side']); // idempotent — 'side' ran once
    // A fresh fallback wakeAt is stamped for the next window.
    expect((await store.getRun('run1'))?.wakeAt).toBe(now + 60_000);

    // The real wake still completes it normally.
    const done = await engine.signal('go', {});
    expect(done?.status).toBe('completed');
    expect(ran).toEqual(['side']);
  });

  it('reconcileMs: 0 disables the fallback (preserves the prior wake-on-event-only behavior)', async () => {
    const store = new InMemoryStateStore();
    const now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now, reconcileMs: 0 });

    engine.register('approval', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'done';
    });

    await startRun(engine, 'approval', {}, 'run1');
    expect((await store.getRun('run1'))?.wakeAt).toBeUndefined();
  });
});
