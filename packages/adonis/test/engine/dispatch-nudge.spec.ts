import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { ControlMessage, ControlPlane } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A shared in-process control plane (broadcasts to every subscriber, like Redis pub/sub). */
function sharedControlPlane(): ControlPlane {
  const handlers = new Set<(m: ControlMessage) => void>();
  return {
    async publishControl(msg) {
      for (const h of handlers) h(msg);
    },
    onControl(h) {
      handlers.add(h);
    },
  };
}

describe('low-latency dispatch nudge', () => {
  it('a run enqueued on one instance is picked up by a worker instance at once (no poll)', async () => {
    const store = new InMemoryStateStore();
    const cp = sharedControlPlane();
    // API pod: enqueue-only (no-op dispatcher). Worker pod: also no-op, but wires onEnqueued.
    const api = new WorkflowEngine({
      store,
      controlPlane: cp,
      instanceId: 'api',
      runDispatcher: { dispatch: () => {} },
    });
    const worker = new WorkflowEngine({
      store,
      controlPlane: cp,
      instanceId: 'worker',
      runDispatcher: { dispatch: () => {} },
    });
    for (const e of [api, worker]) e.register('w', '1', async () => 'done');
    worker.onEnqueued((runId) => void worker.runOne(runId));

    await api.start('w', {}, 'r1'); // enqueues + broadcasts `enqueued`; worker runs it — no runPending
    const result = await worker.waitForRun('r1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
  });
});
