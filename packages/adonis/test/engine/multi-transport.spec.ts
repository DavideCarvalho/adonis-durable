import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A capturing transport whose dispatch can be made to fail, and whose result handler is exposed. */
class FakeTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  constructor(private readonly failDispatch = false) {}
  async dispatch(task: RemoteTask): Promise<void> {
    if (this.failDispatch) throw new Error('transport down');
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
  async complete(task: RemoteTask): Promise<void> {
    await this.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { pong: true },
    });
  }
}

describe('multiple transports — failover + per-step selection', () => {
  it('falls over to the next transport when the first dispatch fails, stamping the one used', async () => {
    const a = new FakeTransport(true); // primary is down
    const b = new FakeTransport();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transports: [
        { id: 'a', transport: a },
        { id: 'b', transport: b },
      ],
    });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.ping', {}));

    await startRun(engine, 'wf', {}, 'r1');

    expect(a.dispatched).toHaveLength(0);
    expect(b.dispatched).toHaveLength(1);
    expect(b.dispatched[0]?.transport).toBe('b'); // the task carries the transport that delivered it
  });

  it('dispatches on the transport a step pins via ctx.step opts', async () => {
    const a = new FakeTransport();
    const b = new FakeTransport();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transports: [
        { id: 'a', transport: a },
        { id: 'b', transport: b },
      ],
    });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'b' }));

    await startRun(engine, 'wf', {}, 'r1');

    expect(a.dispatched).toHaveLength(0);
    expect(b.dispatched).toHaveLength(1);
    expect(b.dispatched[0]?.transport).toBe('b');
  });

  it('completes from a result delivered on any pool transport', async () => {
    const a = new FakeTransport();
    const b = new FakeTransport();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transports: [
        { id: 'a', transport: a },
        { id: 'b', transport: b },
      ],
    });
    engine.register('wf', '1', async (ctx) => {
      const r = await ctx.step<{ pong: boolean }>('ext.ping', {}, { transport: 'b' });
      return r.pong;
    });

    await startRun(engine, 'wf', {}, 'r1');
    const [task] = b.dispatched;
    if (!task) throw new Error('expected a task dispatched on transport b');
    await b.complete(task);
    await new Promise((r) => setImmediate(r));

    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe(true);
  });
});
