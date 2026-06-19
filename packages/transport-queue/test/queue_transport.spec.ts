import type { Heartbeat, RemoteTask, StepResult } from '@agora/durable-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueTransport } from '../src/queue_transport.js';
import { MockAdapter } from './mock_adapter.js';

const POLL = 5;

/** Wait until `cond()` is true (poll loops are async) or fail after a budget. */
async function until(cond: () => boolean, budgetMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  name: 'ext.echo',
  stepId: 'r1:1',
  group: 'ext',
  input: { hello: 'world' },
  attempt: 1,
  ...over,
});

describe('QueueTransport', () => {
  const transports: QueueTransport[] = [];
  const make = (a: MockAdapter, opts: Partial<{ group: string }> = {}) => {
    const t = new QueueTransport({ adapter: () => a, pollIntervalMs: POLL, ...opts });
    transports.push(t);
    return t;
  };

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    vi.restoreAllMocks();
  });

  it('dispatch → worker handler runs → result flows back to onResult', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    worker.handle('ext.echo', async (input) => ({ echoed: input }));

    await engine.dispatch(task());

    await until(() => results.length === 1);
    const r = results[0]!;
    expect(r.status).toBe('completed');
    expect(r.output).toEqual({ echoed: { hello: 'world' } });
    expect(r.stepId).toBe('r1:1');
    expect(typeof r.startedAt).toBe('number');
  });

  it('a throwing handler produces a failed StepResult (not a lost job)', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    worker.handle('ext.echo', async () => {
      throw new Error('boom');
    });

    await engine.dispatch(task());
    await until(() => results.length === 1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error?.message).toBe('boom');
  });

  it('an unknown step name fails with a no-handler result', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });
    worker.handle('ext.other', async () => 1);

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    await engine.dispatch(task({ name: 'ext.echo' }));

    await until(() => results.length === 1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error?.message).toContain('no handler');
  });

  it('routes tasks by group to the matching task queue', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    await engine.dispatch(task({ group: 'payments' }));
    expect(await adapter.sizeOf('durable:tasks:payments')).toBe(1);
    expect(await adapter.sizeOf('durable:tasks:ext')).toBe(0);
  });

  it('honours a custom prefix', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const t = new QueueTransport({ adapter: () => adapter, prefix: 'app', pollIntervalMs: POLL });
    transports.push(t);
    await t.dispatch(task({ group: 'ext' }));
    expect(await adapter.sizeOf('app:tasks:ext')).toBe(1);
  });

  it('heartbeats flow worker → engine', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const beats: Heartbeat[] = [];
    engine.onHeartbeat(async (b) => void beats.push(b));
    await worker.heartbeat({ runId: 'r1', seq: 1, stepId: 'r1:1', group: 'ext' });

    await until(() => beats.length === 1);
    expect(beats[0]).toEqual({ runId: 'r1', seq: 1, stepId: 'r1:1', group: 'ext' });
  });

  it('control messages round-trip and stamp `from` with the instance id', async () => {
    const adapter = new MockAdapter();
    const pub = make(adapter);
    const sub = make(adapter);

    const got: any[] = [];
    sub.onControl((m) => got.push(m));
    await pub.publishControl({ kind: 'cancel', runId: 'r1' });

    await until(() => got.length === 1);
    expect(got[0]).toEqual({ kind: 'cancel', runId: 'r1', from: pub.instanceId });
  });

  it('handle() without a group throws', () => {
    const engine = make(new MockAdapter());
    expect(() => engine.handle('x', async () => 1)).toThrow(/group/);
  });

  it('close() stops loops and destroys the adapter', async () => {
    const adapter = new MockAdapter();
    const t = new QueueTransport({ adapter: () => adapter, group: 'ext', pollIntervalMs: POLL });
    t.handle('ext.echo', async () => 1);
    t.onResult(async () => {});
    await t.close();
    expect(adapter.destroyed).toBe(true);
  });

  it('serializes payloads as JSON (functions dropped on the wire)', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const seen: unknown[] = [];
    engine.onResult(async () => {});
    worker.handle('ext.echo', async (input) => {
      seen.push(input);
      return 'ok';
    });
    await engine.dispatch(task({ input: { keep: 1, fn: (() => 1) as any } }));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ keep: 1 });
  });
});
