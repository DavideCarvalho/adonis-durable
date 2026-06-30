import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  HistoryEvent,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
} from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/** Poll until the run reaches a terminal state (child fan-outs resume the parent on a deferred
 *  microtask, so the parent only completes after every child notifies it). */
async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 400; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/**
 * A hand-scripted stand-in for a Python `@workflow` whose replay emits a cross-SDK
 * `ctx.gather_children("child", inputs)` fan-out: three `startChild` commands carrying the SAME
 * `parallelGroup`, plus one lone (non-fan) `startChild` with no group. The parent suspends until every
 * awaited child settles, then completes. Mirrors the engine-drive harness in `remote-workflow.spec.ts`.
 */
function fanParentExecutor(): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const bySeq = new Map(history.map((e) => [e.seq, e]));
      const base = { taskId: 't', runId: run.id } as const;
      // Emit the whole fan ONCE on the first turn (a worker dispatches every gathered child + the lone
      // child in a single replay), then suspend until each child-await checkpoint lands in history.
      if (history.length === 0) {
        return {
          ...base,
          status: 'continue',
          commands: [
            // The gathered fan: every child stamped with the same group (what `gather_children` emits).
            { kind: 'startChild', seq: 0, workflow: 'child', input: 0, parallelGroup: 'gather:0' },
            { kind: 'startChild', seq: 1, workflow: 'child', input: 1, parallelGroup: 'gather:0' },
            { kind: 'startChild', seq: 2, workflow: 'child', input: 2, parallelGroup: 'gather:0' },
            // A lone, sequential child started OUTSIDE the fan — no group.
            { kind: 'startChild', seq: 3, workflow: 'child', input: 3 },
          ],
        };
      }
      // All four child awaits resolved → complete; otherwise re-suspend (no new ops) and wait.
      if ([0, 1, 2, 3].every((seq) => bySeq.has(seq))) {
        return { ...base, status: 'completed', commands: [], output: { done: true } };
      }
      return { ...base, status: 'continue', commands: [] };
    },
  };
}

/** A trivial child workflow: doubles its numeric input and completes. */
function childExecutor(): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun): Promise<WorkflowDecision> {
      return {
        taskId: 't',
        runId: run.id,
        status: 'completed',
        commands: [],
        output: { doubled: (run.input as number) * 2 },
      };
    },
  };
}

describe('WorkflowEngine — cross-SDK child fan-out parallelGroup', () => {
  it('carries a startChild parallelGroup onto each child-await signal:child checkpoint', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.registerRemote('child', '1', { group: 'py-workflows', executor: childExecutor() });
    engine.registerRemote('parent', '1', { group: 'py-workflows', executor: fanParentExecutor() });

    await startRun(engine, 'parent', {}, 'par1');
    const run = await settle(store, 'par1');
    expect(run.status).toBe('completed');

    // Every child ran as its own run under the deterministic id `${parent}.child.${seq}`.
    for (let seq = 0; seq < 4; seq += 1) {
      expect((await store.getRun(`par1.child.${seq}`))?.status).toBe('completed');
    }

    const cps = await store.listCheckpoints('par1');
    const childAwaits = cps.filter((c) => c.name.startsWith('signal:child:'));
    expect(childAwaits).toHaveLength(4);
    // The three gathered children share the fan group...
    for (let seq = 0; seq < 3; seq += 1) {
      const cp = cps.find((c) => c.seq === seq);
      expect(cp?.kind).toBe('signal');
      expect(cp?.name).toBe(`signal:child:par1.child.${seq}`);
      expect(cp?.parallelGroup).toBe('gather:0');
    }
    // ...while the lone (non-fan) child await carries no group.
    const lone = cps.find((c) => c.seq === 3);
    expect(lone?.name).toBe('signal:child:par1.child.3');
    expect(lone?.parallelGroup).toBeUndefined();
  });
});
