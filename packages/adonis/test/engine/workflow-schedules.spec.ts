import { describe, expect, it } from 'vitest';
import { workflowSchedules } from '../../src/workflow-ref.js';

describe('workflowSchedules (colocated `static schedule` reader)', () => {
  it('normalizes a single schedule object, defaulting key to the workflow name', () => {
    class BulaCrawlCoordinatorWorkflow {
      static workflow = { name: 'bula-crawl-coordinator', version: '1' };
      static schedule = { cron: '0 4 * * *', timezone: 'America/Sao_Paulo' };
      async run() {
        return 'ok';
      }
    }
    expect(workflowSchedules(BulaCrawlCoordinatorWorkflow)).toEqual([
      {
        workflow: 'bula-crawl-coordinator',
        key: 'bula-crawl-coordinator',
        cron: '0 4 * * *',
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });

  it('normalizes an array of schedules, defaulting keys to `${name}:${i}`', () => {
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = [{ everyMs: 60_000 }, { cron: '0 * * * *' }];
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'sync:0', everyMs: 60_000 },
      { workflow: 'sync', key: 'sync:1', cron: '0 * * * *' },
    ]);
  });

  it('preserves an explicit key', () => {
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = { everyMs: 60_000, key: 'nightly' };
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'nightly', everyMs: 60_000 },
    ]);
  });

  it('preserves explicit keys inside an array', () => {
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = [{ everyMs: 60_000, key: 'fast' }, { cron: '0 * * * *' }];
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'fast', everyMs: 60_000 },
      // no explicit key → `${name}:${i}` derived from array position (still stable)
      { workflow: 'sync', key: 'sync:1', cron: '0 * * * *' },
    ]);
  });

  it('returns [] for a class with `static workflow` but no `static schedule`', () => {
    class PlainWorkflow {
      static workflow = { name: 'plain' };
      async run() {}
    }
    expect(workflowSchedules(PlainWorkflow)).toEqual([]);
  });

  it('returns [] for a class with `static schedule` but no `static workflow` (not registrable)', () => {
    class Orphan {
      static schedule = { everyMs: 1000 };
      async run() {}
    }
    expect(workflowSchedules(Orphan)).toEqual([]);
  });

  it('returns [] for a non-class value', () => {
    expect(workflowSchedules(undefined)).toEqual([]);
    expect(workflowSchedules({})).toEqual([]);
    expect(workflowSchedules('sync')).toEqual([]);
  });

  it('derives a DETERMINISTIC default key: same class name → same key across calls', () => {
    class CoordinatorWorkflow {
      static workflow = { name: 'coordinator' };
      static schedule = { cron: '0 4 * * *' };
      async run() {}
    }
    const first = workflowSchedules(CoordinatorWorkflow);
    const second = workflowSchedules(CoordinatorWorkflow);
    expect(first[0]?.key).toBe('coordinator');
    expect(second[0]?.key).toBe(first[0]?.key);
  });
});
