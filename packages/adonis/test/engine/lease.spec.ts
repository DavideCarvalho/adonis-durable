import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const runningRun = (id: string) => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'running' as const,
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('recovery lease', () => {
  it('grants the lease to one owner until it expires', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(runningRun('r1'));

    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true); // A acquires until 2000
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false); // B blocked, lease active
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true); // expired at 2000 → B takes over
  });

  it('releaseRunLock frees the run for another owner immediately', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(runningRun('r1'));
    await store.tryLockRun('r1', 'A', 9_999, 1_000);
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'B', 9_999, 1_001)).toBe(true);
  });

  it('two instances sharing a store never both recover the same run', async () => {
    const store = new InMemoryStateStore();
    let bodyRuns = 0;
    const make = () => {
      const engine = new WorkflowEngine({ store });
      engine.register('wf', '1', async (ctx) =>
        ctx.step('s', async () => {
          bodyRuns += 1;
          return 'ok';
        }),
      );
      return engine;
    };
    const a = make();
    const b = make();
    await store.createRun(runningRun('r1'));

    await Promise.all([a.recoverIncomplete(), b.recoverIncomplete()]);
    await a.waitForRun('r1'); // exactly one instance re-enqueued it; a worker runs it once

    expect(bodyRuns).toBe(1);
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('drain() stops the engine from picking up new runs (graceful shutdown)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'ok');
    await store.createRun(runningRun('r1'));

    await engine.drain();
    const recovered = await engine.recoverIncomplete();

    expect(recovered).toHaveLength(0); // draining → no pickup
    expect((await store.getRun('r1'))?.status).toBe('running'); // left for another instance
  });
});
