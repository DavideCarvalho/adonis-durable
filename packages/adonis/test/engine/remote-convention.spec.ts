import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * An {@link InMemoryTransport} that advertises one live worker group — enough for convention dispatch
 * to discover a same-named workflow's group over the transport, with NO `registerRemote` call.
 */
class GroupAdvertisingTransport extends InMemoryTransport {
  constructor(private readonly groups: string[]) {
    super();
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.groups;
  }
}

describe('WorkflowEngine — convention dispatch is on by default', () => {
  it('routes an unregistered workflow to a live same-named worker group with NO registerRemote', async () => {
    const store = new InMemoryStateStore();
    const transport = new GroupAdvertisingTransport(['pipeline']);
    // A plain default engine — no registerRemote, no local registration. `remoteByConvention` now
    // defaults to true, so starting `pipeline` is routed to the live `pipeline` group as a REMOTE
    // workflow instead of throwing "not registered".
    const engine = new WorkflowEngine({ store, transport });

    const started = await startRun(engine, 'pipeline', 'b1', 'run1');

    // It got PAST the "is not registered" guard: convention synthesized a remote registration and
    // handed the run to a RemoteWorkflowExecutor. This bare in-memory transport can't carry workflow
    // TURNS, so the run fails THERE — which is exactly the proof that it was routed to the remote
    // workflow path (a local/unregistered start could never reach `dispatchWorkflowTask`).
    expect(started.status).toBe('failed');
    const run = await store.getRun('run1');
    expect(run).not.toBeNull();
    expect(run?.error?.message ?? '').toMatch(/workflow task/i);
    expect(run?.error?.message ?? '').not.toMatch(/not registered/i);
  });

  it('opt-out (remoteByConvention: false) restores the fail-fast "is not registered" throw', async () => {
    const store = new InMemoryStateStore();
    const transport = new GroupAdvertisingTransport(['pipeline']);
    const engine = new WorkflowEngine({ store, transport, remoteByConvention: false });

    // Same live group, but the opt-out turns convention off — an unregistered workflow fails fast,
    // before any run is created.
    await expect(startRun(engine, 'pipeline', 'b1', 'run2')).rejects.toThrow('is not registered');
    expect(await store.getRun('run2')).toBeNull();
  });
});
