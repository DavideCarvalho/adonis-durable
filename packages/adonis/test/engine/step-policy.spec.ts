import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { defineStep } from '../../src/step-ref.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('ctx.step — per-call dispatch policy', () => {
  it('surfaces a worker error verbatim when retries are exhausted', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ext.always', async () => {
      throw new Error('nope');
    });
    const engine = new WorkflowEngine({ store, transport });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.always', {}, { retries: 1 }));
    await startRun(engine, 'wf', {}, 'run1');
    const run = await settle(store, 'run1');
    expect(run.status).toBe('failed');
  });

  it('merges a defineStep-declared config with a per-call opts override (opts wins on retries)', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    transport.handle('ext.declared', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 'ok';
    });
    // The def declares retries: 1 (would fail on the first throw); the per-call opts raises it to 2,
    // so the durable retry re-dispatches once and the second attempt succeeds.
    const declared = defineStep('ext.declared', async () => 'ok', { retries: 1, backoffMs: 100 });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('wf', '1', async (ctx) => ctx.step(declared, {}, { retries: 2 }));

    await startRun(engine, 'wf', {}, 'run1');
    await flush(); // attempt 1 fails → suspended awaiting the backoff (proves retries:2 took, not 1)
    expect(attempts).toBe(1);
    expect((await store.getRun('run1'))?.status).toBe('suspended');

    nowMs = 1100;
    await engine.resumeDueTimers(nowMs);
    await flush();
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
    expect(attempts).toBe(2);
  });

  it('a per-call timeoutMs routes through the in-memory liveness path and completes', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ext.quick', async () => 'done');
    const engine = new WorkflowEngine({ store, transport });
    // timeoutMs on the call selects callRemoteInMemory (the heartbeat/liveness branch).
    engine.register('wf', '1', async (ctx) => ctx.step('ext.quick', {}, { timeoutMs: 1_000 }));
    await startRun(engine, 'wf', {}, 'run1');
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.output).toBe('done');
  });
});
