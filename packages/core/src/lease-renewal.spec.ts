import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noDispatch = { dispatch: () => {} };

describe('lease renewal', () => {
  it('renewRunLock extends the lease only for the current owner', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'w',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.tryLockRun('r1', 'A', 1000, 0)).toBe(true);
    // A holds it → A can extend; B cannot.
    expect(await store.renewRunLock('r1', 'A', 5000)).toBe(true);
    expect(await store.renewRunLock('r1', 'B', 9000)).toBe(false);
    // The extension stuck: B can't take it until 5000.
    expect(await store.tryLockRun('r1', 'B', 6000, 4999)).toBe(false);
    expect(await store.tryLockRun('r1', 'B', 6000, 5000)).toBe(true);
  });

  it('keeps a long run from being reclaimed mid-flight, while a crashed run still is', async () => {
    const store = new InMemoryStateStore();
    const e1 = new WorkflowEngine({
      store,
      instanceId: 'e1',
      leaseMs: 100,
      runDispatcher: noDispatch,
    });
    const e2 = new WorkflowEngine({
      store,
      instanceId: 'e2',
      leaseMs: 100,
      runDispatcher: noDispatch,
    });
    let runs = 0;
    const register = (e: WorkflowEngine) =>
      e.register('slow', '1', async (ctx) =>
        ctx.step('work', async () => {
          runs += 1;
          await sleep(300); // outlives the 100ms lease — only renewal keeps it ours
          return 'ok';
        }),
      );
    register(e1);
    register(e2);

    await e1.start('slow', {}, 'r1');
    const running = e1.runOne('r1'); // e1 leases + runs the 300ms step, renewing every 50ms
    await sleep(160); // past the un-renewed 100ms expiry
    const stolen = await e2.recoverIncomplete(); // e1 still holds the (renewed) lease → nothing to steal
    expect(stolen).toHaveLength(0);

    await running;
    expect(runs).toBe(1); // executed exactly once — not double-run
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });
});
