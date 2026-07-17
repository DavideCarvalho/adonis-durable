import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HeartbeatStatus,
  type WorkerDescriptor,
  descriptorHash,
} from '../../src/handshake/descriptor.js';
import type { RemoteTask, StepResult } from '../../src/interfaces.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { effectivePrefix, routingToken } from '../../src/transports/bullmq/naming.js';
import { WORKER_HEARTBEAT_TTL_SECONDS } from '../../src/transports/bullmq/serialization.js';
import {
  RedisWorkerRegistry,
  type WorkerRegistry,
  WorkerRuntime,
  workerDescriptorKey,
  workerHeartbeatKey,
} from '../../src/worker-runtime/index.js';

/** A registry that captures every advertisement + beat, so the two-tier handshake is assertable. */
class FakeRegistry implements WorkerRegistry {
  readonly advertised: Array<{ key: string; descriptor: WorkerDescriptor; ttlSeconds: number }> =
    [];
  readonly beats: Array<{ key: string; status: HeartbeatStatus; ttlSeconds: number }> = [];
  readonly removed: string[][] = [];
  closed = 0;

  async advertiseDescriptor(ad: {
    key: string;
    descriptor: WorkerDescriptor;
    ttlSeconds: number;
  }): Promise<void> {
    // Clone the descriptor so a later mutation of the runtime's set can't retroactively change a capture.
    this.advertised.push({ ...ad, descriptor: structuredClone(ad.descriptor) });
  }

  async beat(beat: { key: string; status: HeartbeatStatus; ttlSeconds: number }): Promise<void> {
    this.beats.push({ ...beat, status: { ...beat.status } });
  }

  async remove(keys: string[]): Promise<void> {
    this.removed.push(keys);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function makeTask(overrides: Partial<RemoteTask> = {}): RemoteTask {
  return {
    runId: 'run-1',
    seq: 1,
    name: 'greet',
    stepId: 'run-1:1',
    group: 'greet@acme',
    input: { who: 'world' },
    attempt: 1,
    ...overrides,
  };
}

describe('WorkerRuntime — consume + execute + publish (store-less step path)', () => {
  it('a dispatched task is consumed, executed through runStepHandler, and its result published', async () => {
    const transport = new InMemoryTransport();
    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });

    const runtime = new WorkerRuntime({ transport, partition: 'acme' });
    runtime.registerStep('greet', (input) => ({ hello: (input as { who: string }).who }));

    await transport.dispatch(makeTask());
    await new Promise((resolve) => setImmediate(resolve));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      runId: 'run-1',
      seq: 1,
      stepId: 'run-1:1',
      status: 'completed',
      output: { hello: 'world' },
    });
  });

  it('a task with no registered handler publishes a failed result (no-handler contract)', async () => {
    const transport = new InMemoryTransport();
    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });
    const runtime = new WorkerRuntime({ transport, partition: 'acme' });
    // Register a DIFFERENT handler so the runtime is live but 'greet' is unknown.
    runtime.registerStep('other', () => 'x');

    await transport.dispatch(makeTask({ name: 'greet' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error?.message).toContain('no handler for greet');
  });

  it('registered step names surface (sorted) for the descriptor', () => {
    const runtime = new WorkerRuntime({ transport: new InMemoryTransport(), partition: 'acme' });
    runtime.registerStep('zeta', () => 1);
    runtime.registerStep('alpha', () => 2);
    expect(runtime.stepNames).toEqual(['alpha', 'zeta']);
  });
});

describe('WorkerRuntime — descriptor advertising (design §7.1/§7.2)', () => {
  let transport: InMemoryTransport;
  let registry: FakeRegistry;

  beforeEach(() => {
    transport = new InMemoryTransport();
    registry = new FakeRegistry();
  });

  function makeRuntime(): WorkerRuntime {
    return new WorkerRuntime({
      transport,
      partition: 'acme',
      instanceId: 'ts-host-42',
      capabilities: ['saga', 'search-attr-v2'],
      registry,
      now: () => 5_000,
    });
  }

  it('advertises the descriptor with the registered steps, workflow names and configured capabilities', async () => {
    const runtime = makeRuntime();
    runtime.registerStep('billing.charge', () => 'ok');
    runtime.registerWorkflowName('CheckoutWorkflow');

    await runtime.start();

    expect(registry.advertised.length).toBeGreaterThan(0);
    const descriptor = registry.advertised.at(-1)?.descriptor as WorkerDescriptor;
    expect(descriptor.steps).toEqual(['billing.charge']);
    expect(descriptor.workflows).toEqual(['CheckoutWorkflow']);
    expect(descriptor.capabilities).toEqual(['saga', 'search-attr-v2']);
    expect(descriptor.partition).toBe('acme');
    expect(descriptor.instanceId).toBe('ts-host-42');
    expect(descriptor.runtime).toBe('node');
    expect(descriptor.protocol).toEqual({ version: 1, range: [1, 1] });

    await runtime.stop();
  });

  it('advertises the descriptor under the ${P}-worker-descriptor:<token>:<instance> key per handled token', async () => {
    const runtime = makeRuntime();
    runtime.registerStep('billing.charge', () => 'ok');
    await runtime.start();

    const effPrefix = effectivePrefix('durable', undefined);
    const token = routingToken('billing.charge', 'acme');
    const expectedKey = workerDescriptorKey(effPrefix, token, 'ts-host-42');
    expect(token).toBe('billing.charge@acme');
    expect(registry.advertised.some((a) => a.key === expectedKey)).toBe(true);

    await runtime.stop();
  });

  it('beats the compact heartbeat carrying the descriptorHash ETag under the worker-heartbeat key', async () => {
    const runtime = makeRuntime();
    runtime.registerStep('billing.charge', () => 'ok');
    await runtime.start();

    const expectedHash = descriptorHash(runtime.descriptor());
    const effPrefix = effectivePrefix('durable', undefined);
    const token = routingToken('billing.charge', 'acme');
    const beat = registry.beats.find(
      (b) => b.key === workerHeartbeatKey(effPrefix, token, 'ts-host-42'),
    );
    expect(beat).toBeDefined();
    expect(beat?.status).toEqual({ ts: 5_000, status: 'up', descriptorHash: expectedHash });
    expect(beat?.ttlSeconds).toBe(WORKER_HEARTBEAT_TTL_SECONDS);

    await runtime.stop();
  });

  it('re-advertises when a new handler is registered after start (routing stays current)', async () => {
    const runtime = makeRuntime();
    runtime.registerStep('billing.charge', () => 'ok');
    await runtime.start();
    const before = registry.advertised.length;

    runtime.registerStep('billing.refund', () => 'ok');
    await new Promise((resolve) => setImmediate(resolve));

    expect(registry.advertised.length).toBeGreaterThan(before);
    expect(registry.advertised.at(-1)?.descriptor.steps).toEqual([
      'billing.charge',
      'billing.refund',
    ]);

    await runtime.stop();
  });

  it('namespace segments the effective prefix on the advertised keys', async () => {
    const runtime = new WorkerRuntime({
      transport,
      partition: 'acme',
      namespace: 'staging',
      instanceId: 'ts-host-42',
      registry,
    });
    runtime.registerStep('billing.charge', () => 'ok');
    await runtime.start();

    const effPrefix = effectivePrefix('durable', 'staging');
    expect(effPrefix).toBe('durable-staging');
    const token = routingToken('billing.charge', 'acme');
    expect(
      registry.advertised.some(
        (a) => a.key === workerDescriptorKey(effPrefix, token, 'ts-host-42'),
      ),
    ).toBe(true);

    await runtime.stop();
  });

  it('stop() removes the instance keys and closes the registry (graceful drain)', async () => {
    const runtime = makeRuntime();
    runtime.registerStep('billing.charge', () => 'ok');
    await runtime.start();
    await runtime.stop();

    expect(registry.removed).toHaveLength(1);
    const effPrefix = effectivePrefix('durable', undefined);
    const token = routingToken('billing.charge', 'acme');
    expect(registry.removed[0]).toContain(workerDescriptorKey(effPrefix, token, 'ts-host-42'));
    expect(registry.removed[0]).toContain(workerHeartbeatKey(effPrefix, token, 'ts-host-42'));
    expect(registry.closed).toBe(1);
  });

  it('start() is idempotent (a second start advertises no extra time)', async () => {
    const runtime = makeRuntime();
    runtime.registerStep('billing.charge', () => 'ok');
    await runtime.start();
    const count = registry.advertised.length;
    await runtime.start();
    expect(registry.advertised.length).toBe(count);
    await runtime.stop();
  });
});

describe('WorkerRuntime — descriptor is observable without a backend (NoopRegistry default)', () => {
  it('builds the descriptor even with no registry (advertising is a no-op)', () => {
    const runtime = new WorkerRuntime({
      transport: new InMemoryTransport(),
      partition: 'acme',
      instanceId: 'ts-host-1',
    });
    runtime.registerStep('a.step', () => 1);
    runtime.registerWorkflowName('W');
    const d = runtime.descriptor();
    expect(d.steps).toEqual(['a.step']);
    expect(d.workflows).toEqual(['W']);
    expect(d.partition).toBe('acme');
  });
});

describe('RedisWorkerRegistry — SET key value EX ttl (byte-compatible advertisement)', () => {
  it('writes the descriptor + heartbeat with SET…EX and deletes keys on remove', async () => {
    const set = vi.fn(async () => 'OK');
    const del = vi.fn(async () => 1);
    const disconnect = vi.fn();
    const registry = new RedisWorkerRegistry({ set, del, disconnect }, { ownsConnection: true });

    const descriptor = {
      instanceId: 'ts-host-1',
      runtime: 'node' as const,
      sdk: { name: 's', version: '1' },
      protocol: { version: 1, range: [1, 1] as [number, number] },
      capabilities: [],
      workflows: [],
      steps: ['a'],
      startedAt: 1,
    };
    await registry.advertiseDescriptor({ key: 'desc-key', descriptor, ttlSeconds: 35 });
    expect(set).toHaveBeenCalledWith('desc-key', JSON.stringify(descriptor), 'EX', 35);

    const status = { ts: 5, status: 'up' as const, descriptorHash: 'abc' };
    await registry.beat({ key: 'hb-key', status, ttlSeconds: 35 });
    expect(set).toHaveBeenCalledWith('hb-key', JSON.stringify(status), 'EX', 35);

    await registry.remove(['desc-key', 'hb-key']);
    expect(del).toHaveBeenCalledWith('desc-key', 'hb-key');

    await registry.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
