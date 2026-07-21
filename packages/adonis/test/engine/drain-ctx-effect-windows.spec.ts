import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Gates ONE store write (a `createRun` for a run id, or an `updateRun` whose patch matches a predicate)
 * so a test can hold open the escape window a fire-and-forget internal effect leaves between the
 * settling/cancelling run and the effect's own store I/O. Pre-fix, these three effects were untracked
 * `queueMicrotask(...)` calls, so `drain()` could observe both registries (`inflight` + `postSettle`)
 * empty in the gap and return early — letting the write land after a torn-down connection (a rolled-back
 * Lucid test transaction → "Transaction query already complete").
 */
class GatedWriteStore extends InMemoryStateStore {
  gate: {
    op: 'create' | 'update' | 'get';
    runId: string;
    when?: (patch: Partial<WorkflowRun>) => boolean;
    /** For `get`: let the first N matching reads pass before gating (skip a caller's own lookup). */
    skip?: number;
  } | null = null;
  writeStarted = false;
  writeCompleted = false;
  private release!: () => void;
  private readonly barrier = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  /** Let the held operation through. */
  open(): void {
    this.release();
  }

  override async createRun(run: WorkflowRun): Promise<void> {
    if (this.gate?.op === 'create' && run.id === this.gate.runId) {
      this.writeStarted = true;
      await this.barrier;
      await super.createRun(run);
      this.writeCompleted = true;
      return;
    }
    await super.createRun(run);
  }

  override async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const g = this.gate;
    if (g?.op === 'update' && runId === g.runId && (g.when?.(patch) ?? true)) {
      this.writeStarted = true;
      await this.barrier;
      await super.updateRun(runId, patch);
      this.writeCompleted = true;
      return;
    }
    await super.updateRun(runId, patch);
  }

  override async getRun(runId: string): Promise<WorkflowRun | null> {
    const g = this.gate;
    if (g?.op === 'get' && runId === g.runId) {
      if ((g.skip ?? 0) > 0) {
        g.skip = (g.skip ?? 0) - 1;
        return super.getRun(runId);
      }
      // Gate this read (and every later one, so drain can't slip through) — used to hold `resume()`
      // parked BEFORE it enters `inflight`, isolating the pre-inflight microtask gap the fix closes.
      this.writeStarted = true;
      await this.barrier;
      const r = await super.getRun(runId);
      this.writeCompleted = true;
      return r;
    }
    return super.getRun(runId);
  }
}

describe('drain waits for fire-and-forget ctx effects (cancelChild / signalEntity / compensation resume)', () => {
  it('window 1 — drain() waits for a ctx.cancelChild (failFast sibling cancel) store write', async () => {
    const store = new GatedWriteStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (ctx, input) => {
      const p = (input as { p: string }).p;
      if (p === 'bad') throw new Error('boom-fast');
      // Parks forever — only the parent's failFast cancellation can settle it.
      await ctx.waitForSignal('never');
      return `out-${p}`;
    });
    engine.register('parent', '1', async (ctx) =>
      ctx.all('handle', [{ p: 'bad' }, { p: 'slow' }], { mode: 'failFast' }),
    );

    // Gate the surviving sibling's cancel write — the store I/O the deferred cancelChild issues.
    store.gate = {
      op: 'update',
      runId: 'p1.all.0.1',
      when: (patch) => patch.status === 'cancelled',
    };

    await engine.start('parent', {}, 'p1');
    // Let the bad child fail, the parent settle `failed`, and cancelChild reach the gated cancel write.
    for (let i = 0; i < 50 && !store.writeStarted; i += 1) await flush();
    expect((await store.getRun('p1'))?.status).toBe('failed');
    expect(store.writeStarted).toBe(true);
    expect(store.writeCompleted).toBe(false);

    // drain() must NOT resolve while the sibling's cancel write is still open. Pre-fix the cancelChild
    // was an untracked queueMicrotask(cancel), so both registries read empty here and drain returned.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    expect(store.writeCompleted).toBe(true);
    expect((await store.getRun('p1.all.0.1'))?.status).toBe('cancelled');
  });

  it('window 2 — drain() waits for a ctx.signalEntity dispatch (entity run persist)', async () => {
    const store = new GatedWriteStore();
    const engine = new WorkflowEngine({ store });
    engine.registerEntity<{ count: number }>('counter', {
      initialState: () => ({ count: 0 }),
      handlers: {
        increment: (s, by) => {
          s.count += by as number;
        },
      },
    });
    engine.register('emit', '1', async (ctx) => {
      await ctx.signalEntity('counter', 'k', 'increment', 1);
      return 'emitted';
    });

    // Gate the entity run's persist — `entities.dispatch` → signalWithStart → createRun('entity:...').
    store.gate = { op: 'create', runId: 'entity:counter:k' };

    await engine.start('emit', {}, 'e1');
    for (let i = 0; i < 50 && !store.writeStarted; i += 1) await flush();
    // The emitting workflow completed; the entity dispatch is parked at its gated persist.
    expect((await store.getRun('e1'))?.status).toBe('completed');
    expect(store.writeStarted).toBe(true);
    expect(store.writeCompleted).toBe(false);

    // Pre-fix: signalEntity was an untracked queueMicrotask(entities.dispatch), so drain saw empty
    // registries and returned before the entity op persisted.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    expect(store.writeCompleted).toBe(true);
    expect((await store.getRun('entity:counter:k'))?.status).not.toBeUndefined();
  });

  it('window 3 — drain() waits for a compensating cancel to run its saga undo to `cancelled`', async () => {
    const store = new GatedWriteStore();
    const engine = new WorkflowEngine({ store });
    const undone: string[] = [];
    engine.register('saga', '1', async (ctx) => {
      await ctx.localStep('reserve', async () => 'r', {
        compensate: async () => {
          undone.push('reserve');
        },
      });
      await ctx.waitForSignal('ship'); // suspends here, mid-saga
      return 'done';
    });

    await engine.start('saga', {}, 'r1');
    for (let i = 0; i < 50 && (await store.getRun('r1'))?.status !== 'suspended'; i += 1)
      await flush();
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    // Gate the background resume at its FIRST store read — parking it BEFORE `resume()` enters
    // `inflight` (its `track(execute)` runs only after this getRun). `skip: 1` lets cancel's own
    // top-of-method getRun through; the next getRun('r1') is the resume's, which we hold. This isolates
    // the exact pre-inflight microtask gap: pre-fix the resume was an untracked `queueMicrotask`, so
    // with execute not yet reached and nothing in `postSettle`, `drain()` saw both registries empty.
    store.gate = { op: 'get', runId: 'r1', skip: 1 };

    // cancel({compensate}) returns immediately and schedules the resume+undo in the background.
    await engine.cancel('r1', { compensate: true });
    for (let i = 0; i < 50 && !store.writeStarted; i += 1) await flush();
    expect(store.writeStarted).toBe(true); // resume reached its first read, still parked (pre-inflight)
    expect(undone).toEqual([]); // undo has NOT run yet (execute not reached)

    // drain() must NOT resolve while the resume is parked before `inflight`. Pre-fix: untracked
    // queueMicrotask + not-yet-inflight → both registries empty → drain returned early. Fixed: the
    // deferred resume is held in `postSettle` (registered synchronously in cancel()).
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    // The undo ran and the run reached its terminal `cancelled` state before drain resolved.
    expect(undone).toEqual(['reserve']);
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
  });
});
