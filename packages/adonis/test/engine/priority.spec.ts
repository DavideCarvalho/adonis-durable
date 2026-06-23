import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('run-level priority dispatch', () => {
  it('persists a run-level priority from StartOptions onto the run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('etl', '1', async () => 'done');

    await engine.start('etl', {}, 'r1', { priority: 7 });

    expect((await store.getRun('r1'))?.priority).toBe(7);
  });

  it('leaves a run started without a priority unprioritised (FIFO path untouched)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('etl', '1', async () => 'done');

    await engine.start('etl', {}, 'r2');

    expect((await store.getRun('r2'))?.priority).toBeUndefined();
  });
});
