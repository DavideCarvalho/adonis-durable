import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './interfaces.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

function run(id: string, createdAt: Date): WorkflowRun {
  return {
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    createdAt,
    updatedAt: createdAt,
  };
}

describe('listRuns ordering', () => {
  it('returns runs newest-first (most recent createdAt on top)', async () => {
    const store = new InMemoryStateStore();
    // Insert oldest-first, so a passing test proves the order comes from createdAt, not insertion.
    await store.createRun(run('old', new Date('2026-01-01T00:00:00Z')));
    await store.createRun(run('mid', new Date('2026-02-01T00:00:00Z')));
    await store.createRun(run('new', new Date('2026-03-01T00:00:00Z')));

    const runs = await store.listRuns({});
    expect(runs.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});
