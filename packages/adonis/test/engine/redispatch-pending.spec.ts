import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const PING = 'ext.ping';

/** A transport that captures dispatches but never delivers a result on its own — models a worker that
 *  crashed (or a dropped job): the run stays `pending` until something re-dispatches. `complete` lets a
 *  test deliver a result for a chosen dispatched task. */
class LostTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
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

describe('redispatchPending (manual recovery of a lost remote-step dispatch)', () => {
  it('re-dispatches a stuck pending remote step and lets the fresh result complete the run', async () => {
    const transport = new LostTransport();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
    engine.register('wf', '1', async (ctx) => {
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    await startRun(engine, 'wf', {}, 'r1');
    expect(transport.dispatched).toHaveLength(1); // dispatched once, then suspended (result never came)
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    const res = await engine.redispatchPending('r1');
    expect(res).toMatchObject({ runId: 'r1', status: 'suspended', redispatched: 1 });
    expect(transport.dispatched).toHaveLength(2); // same step re-enqueued
    expect(transport.dispatched[1]?.seq).toBe(transport.dispatched[0]?.seq);

    const task = transport.dispatched[1];
    if (!task) throw new Error('expected a re-dispatched task');
    await transport.complete(task);
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe(true);
  });

  it('bumps the checkpoint attempts when re-dispatching', async () => {
    const transport = new LostTransport();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
    engine.register('wf', '1', async (ctx) => ctx.step(PING, {}));
    await startRun(engine, 'wf', {}, 'r1');
    const before = (await store.listCheckpoints('r1')).find((c) => c.name === PING);
    await engine.redispatchPending('r1');
    const after = (await store.listCheckpoints('r1')).find((c) => c.name === PING);
    expect(after?.attempts).toBe((before?.attempts ?? 0) + 1);
  });

  it('is a no-op (redispatched: 0) for a run with no pending remote steps', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'done');
    await startRun(engine, 'wf', {}, 'r1'); // completes immediately, no remote steps
    expect(await engine.redispatchPending('r1')).toEqual({
      runId: 'r1',
      status: 'completed',
      redispatched: 0,
    });
  });

  it('returns null for an unknown run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    expect(await engine.redispatchPending('nope')).toBeNull();
  });
});

describe('remoteRedispatchMs — opt-in self-heal of a lost dispatch on replay', () => {
  function setup(opts: { remoteRedispatchMs?: number; remoteRedispatchMax?: number }) {
    let now = 1_000_000;
    const transport = new LostTransport();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0, // isolate: drive replays explicitly via runOne, no reconcile fallback
      ...opts,
    });
    engine.register('wf', '1', async (ctx) => ctx.step(PING, {}));
    return {
      engine,
      store,
      transport,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('does NOT re-dispatch when unset — a pending step just re-suspends (the by-design behavior)', async () => {
    const { engine, transport, advance } = setup({});
    await startRun(engine, 'wf', {}, 'r1');
    expect(transport.dispatched).toHaveLength(1);
    advance(10_000_000);
    await engine.runOne('r1'); // replay
    expect(transport.dispatched).toHaveLength(1); // still not re-dispatched
  });

  it('re-dispatches once the pending step passes remoteRedispatchMs, not before', async () => {
    const { engine, transport, advance } = setup({ remoteRedispatchMs: 1000 });
    await startRun(engine, 'wf', {}, 'r1');
    expect(transport.dispatched).toHaveLength(1);

    // First replay stamps the deadline (clock + 1000) and re-suspends — no re-dispatch yet.
    await engine.runOne('r1');
    expect(transport.dispatched).toHaveLength(1);

    // Before the deadline: still no re-dispatch.
    advance(500);
    await engine.runOne('r1');
    expect(transport.dispatched).toHaveLength(1);

    // Past the deadline: re-dispatch the same step.
    advance(600);
    await engine.runOne('r1');
    expect(transport.dispatched).toHaveLength(2);
    expect(transport.dispatched[1]?.seq).toBe(transport.dispatched[0]?.seq);
  });

  it('fails the run (remote_step_lost) after remoteRedispatchMax re-dispatches without a result', async () => {
    const { engine, store, transport, advance } = setup({
      remoteRedispatchMs: 1000,
      remoteRedispatchMax: 2,
    });
    await startRun(engine, 'wf', {}, 'r1');
    // Drive repeated past-deadline replays; each re-dispatch bumps attempts until the cap trips.
    for (let i = 0; i < 6; i++) {
      advance(2000);
      await engine.runOne('r1').catch(() => undefined);
    }
    const run = await store.getRun('r1');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('lost');
    expect(transport.dispatched.length).toBeGreaterThanOrEqual(2);
  });
});
