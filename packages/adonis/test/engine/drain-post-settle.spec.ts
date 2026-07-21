import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Wraps the in-memory store to gate the ONE write a singleton `wakeNext` issues AFTER a run settled —
 * `updateRun(gatedRunId, { wakeAt: undefined })`, its only `wakeAt: undefined` writer — so a test can
 * hold that post-settle effect open and observe (a) whether `drain()` waits for it and (b) whether the
 * `execute()`/`settleRun` path blocked on it. This mirrors the production hazard: the write escaping
 * onto a torn-down connection (a rolled-back Lucid test transaction) after the suite thought it was
 * done, surfacing as an unhandled "Transaction query already complete".
 */
class GatedWakeStore extends InMemoryStateStore {
  gateRunId: string | null = null;
  wakeWriteStarted = false;
  wakeWriteCompleted = false;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  /** Let the held post-settle write through. */
  open(): void {
    this.release();
  }

  override async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const isWakeClear = 'wakeAt' in patch && patch.wakeAt === undefined;
    if (this.gateRunId != null && runId === this.gateRunId && isWakeClear) {
      this.wakeWriteStarted = true;
      await this.gate;
      await super.updateRun(runId, patch);
      this.wakeWriteCompleted = true;
      return;
    }
    await super.updateRun(runId, patch);
  }
}

function makeSingletonEngine(store: InMemoryStateStore): WorkflowEngine {
  const now = 1000;
  const engine = new WorkflowEngine({ store, clock: () => now });
  engine.register(
    'job',
    '1',
    async (ctx, input) => {
      const { id } = input as { id: string; key: string };
      await ctx.waitForSignal(`go:${id}`); // hold the singleton slot until signalled
      return 'done';
    },
    { singleton: { key: (input) => (input as { key: string }).key } },
  );
  return engine;
}

describe('drain waits for post-settle effects (parent notify / singleton wake)', () => {
  it('drain() does not resolve until a settled run’s singleton wakeNext write completes', async () => {
    const store = new GatedWakeStore();
    const engine = makeSingletonEngine(store);

    // A takes the only slot and holds it (suspended on its signal); B shares the key → gated.
    await startRun(engine, 'job', { id: 'A', key: 'k' }, 'a');
    await startRun(engine, 'job', { id: 'B', key: 'k' }, 'b');
    expect((await store.getRun('b'))?.status).toBe('suspended');

    // Arm the gate on B's clear-timer write, the write wakeNext issues to hand B its freed slot.
    store.gateRunId = 'b';

    // Completing A settles it and fires wakeNext(A) fire-and-forget. `signal` returns WITHOUT awaiting
    // that effect (proven separately below); here we only need A settled + the effect detached.
    const a = await engine.signal('go:A', undefined);
    expect(a?.status).toBe('completed');

    // The detached effect reaches its now-blocked write.
    await flush();
    expect(store.wakeWriteStarted).toBe(true);
    expect(store.wakeWriteCompleted).toBe(false);

    // drain() must NOT resolve while that post-settle write is still open. On the pre-fix engine
    // (drain only awaited `inflight`, and A/B's executions had already resolved) drain returns
    // immediately here and this assertion fails.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    expect(store.wakeWriteCompleted).toBe(true);
  });

  it('execute()/settle does not block on the post-settle effect', async () => {
    const store = new GatedWakeStore();
    const engine = makeSingletonEngine(store);

    await startRun(engine, 'job', { id: 'A', key: 'k' }, 'a');
    await startRun(engine, 'job', { id: 'B', key: 'k' }, 'b');

    // Hold wakeNext's write open indefinitely (never released until after we've observed the settle).
    store.gateRunId = 'b';

    // If the settle path awaited the effect, this signal would never resolve (the effect is blocked)
    // and the test would hang to timeout. It resolving proves the run returned without waiting on
    // wakeNext — the effect is genuinely off the execute() critical path.
    const a = await engine.signal('go:A', undefined);
    expect(a?.status).toBe('completed');
    expect(store.wakeWriteCompleted).toBe(false);

    store.open();
    await engine.drain();
  });
});
