import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('recoverIncomplete re-enqueues (non-blocking)', () => {
  it('does NOT run a long inline step during recovery — it re-enqueues for a worker', async () => {
    const store = new InMemoryStateStore();
    // No-op dispatcher = the recovering instance must not execute the run itself (e.g. a worker
    // booting must not block readiness rebuilding a big export inline).
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    let started = false;
    engine.register('slow', '1', async (ctx) =>
      ctx.step('build', async () => {
        started = true;
        await new Promise((r) => setTimeout(r, 10_000)); // a long inline step (e.g. a big CSV export)
        return 'done';
      }),
    );
    // A run left `running` by a crashed worker.
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'slow',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: now,
      updatedAt: now,
    });

    const recovered = await engine.recoverIncomplete(); // must return immediately

    expect(recovered).toEqual([{ runId: 'r1', status: 'pending' }]);
    expect(started).toBe(false); // the long step did NOT run inline during recovery
    expect((await store.getRun('r1'))?.status).toBe('pending'); // re-enqueued for a worker to run
  });
});
