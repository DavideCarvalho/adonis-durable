import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('executionTimeout (sweepTimeouts)', () => {
  it('cancels an in-flight run older than its execution timeout, leaves younger ones', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('slow', '1', async () => undefined, { executionTimeout: '1h' });
    engine.register('untimed', '1', async () => undefined); // no timeout

    // A suspended run created at epoch 1000 (controls createdAt directly).
    const at = new Date(1000);
    await store.createRun({
      id: 'old',
      workflow: 'slow',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      createdAt: at,
      updatedAt: at,
    });
    await store.createRun({
      id: 'safe',
      workflow: 'untimed',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      createdAt: at,
      updatedAt: at,
    });

    // Before the 1h deadline → no-op.
    await engine.sweepTimeouts(1000 + 1_000_000);
    expect((await store.getRun('old'))?.status).toBe('suspended');

    // Past the 1h deadline → `old` is cancelled; the untimed `safe` run is untouched.
    await engine.sweepTimeouts(1000 + 3_700_000);
    const old = await store.getRun('old');
    expect(old?.status).toBe('cancelled');
    expect(old?.error?.code).toBe('execution_timeout');
    expect((await store.getRun('safe'))?.status).toBe('suspended');
  });
});
