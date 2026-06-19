import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('workflow tags', () => {
  it('merges @Workflow static tags with per-run tags onto the run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('etl', '1', async () => 'done', { tags: ['etl', 'critical'] });

    await engine.start('etl', {}, 'r1', { tags: ['nightly', 'etl'] }); // 'etl' dup is deduped

    const run = await store.getRun('r1');
    expect(run?.tags).toEqual(['etl', 'critical', 'nightly']);
  });

  it('records static tags even with no per-run tags', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('sync', '1', async () => 'ok', { tags: ['integration'] });
    await engine.start('sync', {}, 'r2');
    expect((await store.getRun('r2'))?.tags).toEqual(['integration']);
  });

  it('filters listRuns by tag', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('a', '1', async () => 1, { tags: ['etl'] });
    engine.register('b', '1', async () => 2, { tags: ['ml'] });
    await engine.start('a', {}, 'ra');
    await engine.start('b', {}, 'rb');

    expect((await store.listRuns({ tag: 'etl' })).map((r) => r.id)).toEqual(['ra']);
    expect((await store.listRuns({ tag: 'ml' })).map((r) => r.id)).toEqual(['rb']);
    expect(await store.listRuns({ tag: 'none' })).toHaveLength(0);
  });
});
