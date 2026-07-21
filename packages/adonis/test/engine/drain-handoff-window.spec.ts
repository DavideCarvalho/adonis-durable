import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Gates the `createRun` write of ONE run id — the durable persist an internal handoff (continue-as-new's
 * next run, a deferred child) issues on the settle path. Holding it open lets a test reproduce the
 * escape window the review flagged: between the parent settling and the handoff's new run entering
 * `inflight` there are microtask hops + this store I/O, and the pre-fix bridge
 * (`queueMicrotask(() => void this.start(...))`) left that write UNtracked, so `drain()` could observe
 * both registries empty and return early — letting the write land after a torn-down connection (a
 * rolled-back Lucid test transaction → "Transaction query already complete").
 */
class GatedCreateStore extends InMemoryStateStore {
  gateRunId: string | null = null;
  createStarted = false;
  createCompleted = false;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  /** Let the held `createRun` through. */
  open(): void {
    this.release();
  }

  override async createRun(run: WorkflowRun): Promise<void> {
    if (this.gateRunId != null && run.id === this.gateRunId) {
      this.createStarted = true;
      await this.gate;
      await super.createRun(run);
      this.createCompleted = true;
      return;
    }
    await super.createRun(run);
  }
}

describe('drain waits for internal run handoffs (continue-as-new / deferred child)', () => {
  it('drain() does not resolve until a continue-as-new continuation is persisted and processed', async () => {
    const store = new GatedCreateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('chain', '1', async (ctx, input) => {
      const { n } = input as { n: number };
      // First run hands off to a fresh execution; the continuation (n = 1) just completes.
      if (n === 0) await ctx.continueAsNew({ n: 1 });
      return `done-${n}`;
    });

    // Gate the continuation run's persist so the handoff parks mid-flight, holding the window open.
    store.gateRunId = 'p~1';

    await engine.start('chain', { n: 0 }, 'p');
    await flush();

    // Parent settled (continue-as-new completes it), and the handoff has reached the gated persist.
    expect((await store.getRun('p'))?.status).toBe('completed');
    expect(store.createStarted).toBe(true);
    expect(store.createCompleted).toBe(false);

    // drain() must NOT resolve while the continuation's persist is still open. On the pre-fix engine the
    // handoff was an untracked `queueMicrotask(start)`, so both registries read empty here and drain
    // returned immediately → this assertion failed and the continuation's writes escaped the drain.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    // The continuation was persisted AND processed to completion before drain resolved.
    expect(store.createCompleted).toBe(true);
    expect((await store.getRun('p~1'))?.status).toBe('completed');
    expect((await store.getRun('p~1'))?.output).toBe('done-1');
  });

  it('drain() does not resolve until a deferred child is persisted, processed, and its parent resumed', async () => {
    const store = new GatedCreateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('parent', '1', async (ctx) => {
      const r = await ctx.child<string>('kid', {}, 'kid-1');
      return `parent:${r}`;
    });
    engine.register('kid', '1', async () => 'kid-done');

    // Gate the child's persist: the parent suspends on `child:kid-1` while the handoff parks here.
    store.gateRunId = 'kid-1';

    await engine.start('parent', {}, 'p');
    await flush();

    expect((await store.getRun('p'))?.status).toBe('suspended');
    expect(store.createStarted).toBe(true);
    expect(store.createCompleted).toBe(false);

    // Pre-fix: the deferred child start was untracked, so drain saw empty registries and returned early.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    // The child ran to completion and its parent was resumed to completion — all before drain resolved.
    expect((await store.getRun('kid-1'))?.status).toBe('completed');
    expect((await store.getRun('p'))?.status).toBe('completed');
    expect((await store.getRun('p'))?.output).toBe('parent:kid-done');
  });

  it('the settle path does NOT block on the handoff (execute returns before the continuation persists)', async () => {
    const store = new GatedCreateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('chain', '1', async (ctx, input) => {
      const { n } = input as { n: number };
      if (n === 0) await ctx.continueAsNew({ n: 1 });
      return `done-${n}`;
    });

    // Hold the continuation's persist open indefinitely.
    store.gateRunId = 'p~1';

    await engine.start('chain', { n: 0 }, 'p');
    // The parent reaches `completed` even though the continuation persist is still gated — proving the
    // handoff is off the execute() critical path (it only holds `drain`, not the settling run).
    const parent = await engine.waitForRun('p', { timeoutMs: 1_000 });
    expect(parent.status).toBe('completed');
    expect(store.createCompleted).toBe(false);

    store.open();
    await engine.drain();
    expect((await store.getRun('p~1'))?.status).toBe('completed');
  });
});
