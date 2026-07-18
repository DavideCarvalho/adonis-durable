import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * An {@link InMemoryTransport} that advertises a fixed set of live worker groups — the input convention
 * dispatch reads (`pool.listWorkerGroups()`) to decide whether an unregistered workflow name has a
 * same-named group to route to.
 */
class GroupAdvertisingTransport extends InMemoryTransport {
  constructor(private readonly groups: string[]) {
    super();
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.groups;
  }
}

describe('WorkflowEngine — convention dispatch (unconditional, no flag)', () => {
  it('routes an unregistered workflow to a live same-named worker group with NO registerRemote', async () => {
    const store = new InMemoryStateStore();
    const transport = new GroupAdvertisingTransport(['pipeline']);
    // A plain engine — no registerRemote, no local registration, no config flag. Starting `pipeline`
    // must be routed to the live `pipeline` group as a REMOTE workflow rather than throwing.
    const engine = new WorkflowEngine({ store, transport });

    const started = await startRun(engine, 'pipeline', 'b1', 'run1');

    // It got PAST the "is not registered" guard: convention synthesized a remote registration and
    // handed the run to a RemoteWorkflowExecutor. This bare in-memory transport can't carry workflow
    // TURNS, so the run fails THERE — the proof that it was routed to the remote workflow path (an
    // unregistered start could never reach `dispatchWorkflowTask`).
    expect(started.status).toBe('failed');
    const run = await store.getRun('run1');
    expect(run?.error?.message ?? '').toMatch(/workflow task/i);
    expect(run?.error?.message ?? '').not.toMatch(/not registered/i);
  });

  it('still fails fast with "is not registered" when NO live worker group matches the name', async () => {
    const store = new InMemoryStateStore();
    // A live fleet exists, but nothing named `pipeline` — so there is nothing to route to.
    const transport = new GroupAdvertisingTransport(['something-else']);
    const engine = new WorkflowEngine({ store, transport });

    await expect(startRun(engine, 'pipeline', 'b1', 'run2')).rejects.toThrow('is not registered');
    expect(await store.getRun('run2')).toBeNull();
  });
});
