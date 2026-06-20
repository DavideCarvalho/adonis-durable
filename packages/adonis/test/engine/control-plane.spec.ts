import { WorkflowEngine } from '../../src/engine.js';
import type { ControlMessage, ControlPlane } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

// Two engines sharing one transport + store stand in for two pods (e.g. a worker pod that runs the
// workflow and an API/dashboard pod that only observes).
function twoInstances() {
  const store = new InMemoryStateStore();
  // The same broadcast-capable transport doubles as the control plane (passed as both).
  const transport = new InMemoryTransport();
  const worker = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'worker',
  });
  const dashboard = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'dashboard',
  });
  return { store, transport, worker, dashboard };
}

describe('Transport control plane', () => {
  it('broadcasts lifecycle events to other instances (cross-pod live-tail)', async () => {
    const { worker, dashboard } = twoInstances();

    const onWorker: string[] = [];
    const onDashboard: string[] = [];
    worker.subscribe((e) => onWorker.push(e.type));
    dashboard.subscribe((e) => onDashboard.push(e.type));

    worker.register('wf', '1', async (ctx) => {
      await ctx.step('a', async () => 1);
      return 'ok';
    });
    await startRun(worker, 'wf', {}, 'run1');

    // The dashboard pod, which never executed anything, still sees the run's events —
    // including the local step's `step.started` (emitted when its body begins).
    expect(onDashboard).toEqual(['run.started', 'step.started', 'step.completed', 'run.completed']);
    // And the worker delivered each event exactly once (no echo duplicate from its own publish).
    expect(onWorker).toEqual(['run.started', 'step.started', 'step.completed', 'run.completed']);
  });

  it('delivers cancellation to the instance running the work (cooperative cancel)', async () => {
    const { worker, dashboard } = twoInstances();
    const aborted: string[] = [];
    worker.onCancel((runId) => aborted.push(runId));

    worker.register('wf', '1', async (ctx) => ctx.waitForSignal('go'));
    await startRun(worker, 'wf', {}, 'run1'); // suspends, "work" notionally in flight on the worker

    // Cancel issued from the dashboard pod reaches the worker pod's cancel listener.
    await dashboard.cancel('run1');
    expect(aborted).toEqual(['run1']);
  });

  it('degrades to local-only events when no control plane is given', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store }); // no transport, no control plane
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.type));
    engine.register('wf', '1', async () => 'ok');
    await startRun(engine, 'wf', {}, 'run1');
    expect(seen).toEqual(['run.started', 'run.completed']);
  });
});

/** A shared in-memory control plane (a stand-in broker) two engines can both attach to. */
function sharedControlPlane() {
  const subscribers = new Set<(m: ControlMessage) => void>();
  return (): ControlPlane => ({
    async publishControl(m) {
      for (const s of subscribers) s(m);
    },
    onControl(h) {
      subscribers.add(h);
    },
  });
}

describe('control plane — independent of the task transport', () => {
  it('broadcasts cancellation cross-instance through a standalone control plane (no transport)', async () => {
    const make = sharedControlPlane();
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store, controlPlane: make(), instanceId: 'a' });
    const b = new WorkflowEngine({ store, controlPlane: make(), instanceId: 'b' });

    let cancelledOnB: string | undefined;
    b.onCancel((runId) => {
      cancelledOnB = runId;
    });

    a.register('wf', '1', async (ctx) => ctx.waitForSignal('go'));
    await startRun(a, 'wf', {}, 'r1');
    await a.cancel('r1');

    // The cancel rode the control plane to instance b — neither engine has a transport.
    expect(cancelledOnB).toBe('r1');
  });
});
