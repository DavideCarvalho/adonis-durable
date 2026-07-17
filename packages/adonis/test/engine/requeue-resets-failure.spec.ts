import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

async function poll(fn: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('requeue of a FAILED run resets its failure state so replay re-executes', () => {
  it('an exhausted-failed REMOTE step re-dispatches on retry instead of rethrowing in milliseconds', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    let healthy = false;
    transport.handle('ext.step', async () => {
      attempts += 1;
      if (!healthy) throw new Error('worker wedged');
      return 'ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('wf', '1', async (ctx) => ctx.step<string>('ext.step', {}));

    await engine.start('wf', {}, 'r1');
    await flush();
    expect(attempts).toBe(1); // default retries: the single attempt is exhausted
    expect((await store.getRun('r1'))?.status).toBe('failed');

    // Before the reset, requeue replayed straight into the exhausted-failed checkpoint and
    // re-failed without ever re-dispatching (attempts stayed 1).
    healthy = true;
    nowMs += 1;
    await engine.requeue('r1');
    await flush();

    await poll(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(attempts).toBe(2); // the step actually RE-RAN
    expect((await store.getRun('r1'))?.output).toBe('ok');
  });

  it('parent failed by a child failure: retry parent THEN child — parent resumes on the child completion', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let healthy = false;
    transport.handle('ext.child-step', async () => {
      if (!healthy) throw new Error('boom');
      return 'child-ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('child', '1', async (ctx) => ctx.step<string>('ext.child-step', {}));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child<string>('child', {});
      return `parent saw ${out}`;
    });

    await engine.start('parent', {}, 'p1');
    await flush();
    expect((await store.getRun('p1.child.0'))?.status).toBe('failed');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');

    healthy = true;
    nowMs += 1;
    // Parent first: its child-signal FAILURE completion resets to the live placeholder, replay
    // re-registers the `child:<id>` waiter and suspends (the child run exists, so it is NOT
    // re-started by the parent — retrying it is a separate, explicit act).
    await engine.requeue('p1');
    await flush();
    expect((await store.getRun('p1'))?.status).toBe('suspended');

    // Child second: its exhausted step resets, re-runs, completes — and notifies the parent waiter.
    await engine.requeue('p1.child.0');
    await flush();

    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe('parent saw child-ok');
  });

  it('or retry child THEN parent — the buffered child completion is consumed on the parent replay', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let healthy = false;
    transport.handle('ext.child-step2', async () => {
      if (!healthy) throw new Error('boom');
      return 'child-ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('child', '1', async (ctx) => ctx.step<string>('ext.child-step2', {}));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child<string>('child', {});
      return `parent saw ${out}`;
    });

    await engine.start('parent', {}, 'p2');
    await flush();
    await poll(async () => (await store.getRun('p2'))?.status === 'failed');

    healthy = true;
    nowMs += 1;
    await engine.requeue('p2.child.0');
    await flush();
    await poll(async () => (await store.getRun('p2.child.0'))?.status === 'completed');

    await engine.requeue('p2');
    await flush();

    await poll(async () => (await store.getRun('p2'))?.status === 'completed');
    expect((await store.getRun('p2'))?.output).toBe('parent saw child-ok');
  });

  it('requeue of a non-failed run is unchanged (no checkpoint mutation)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async (ctx) => ctx.localStep('s', async () => 'ok'));
    await engine.start('w', {}, 'r1');
    await engine.runPending();
    expect((await store.getRun('r1'))?.status).toBe('completed');

    await engine.requeue('r1'); // requeue of a completed run: replay short-circuits, stays completed
    const [res] = await engine.runPending();
    expect(res?.status).toBe('completed');
  });
});
