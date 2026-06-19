import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('WorkflowEngine — workflow versioning (skew protection)', () => {
  it('starts new runs on the newest registered version', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'v1');
    engine.register('wf', '2', async () => 'v2');

    const result = await startRun(engine, 'wf', {}, 'run1');
    expect(result.output).toBe('v2');
    expect((await store.getRun('run1'))?.workflowVersion).toBe('2');
  });

  it('resumes a run on the version it started on, not the latest', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'v1-result');
    engine.register('wf', '2', async () => 'v2-result');

    // A run that began on v1 (e.g. before a deploy that added v2).
    const now = new Date();
    await store.createRun({
      id: 'old',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: now,
      updatedAt: now,
    });

    const resumed = await engine.resume('old');
    expect(resumed.output).toBe('v1-result'); // pinned to v1, not the newer v2
  });

  it('fails clearly if the run started on a version no longer registered', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '2', async () => 'v2');

    const now = new Date();
    await store.createRun({
      id: 'old',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: now,
      updatedAt: now,
    });

    await expect(engine.resume('old')).rejects.toThrow(/wf@1 is not registered/);
  });
});
