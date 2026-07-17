import { describe, expect, it } from 'vitest';
import { controlPlaneDescriptor, planDispatch } from '../../src/dispatch-routing.js';
import { CURRENT_PROTOCOL_VERSION, type WorkerDescriptor } from '../../src/handshake/descriptor.js';

function worker(partial: Partial<WorkerDescriptor> & { instanceId: string }): WorkerDescriptor {
  return {
    runtime: 'node',
    sdk: { name: 'test', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...partial,
  };
}

describe('controlPlaneDescriptor', () => {
  it('defaults to the current protocol single-major band + empty capabilities', () => {
    const cp = controlPlaneDescriptor({ instanceId: 'cp1' });
    expect(cp.protocol).toEqual({
      version: CURRENT_PROTOCOL_VERSION,
      range: [CURRENT_PROTOCOL_VERSION, CURRENT_PROTOCOL_VERSION],
    });
    expect(cp.capabilities).toEqual([]);
    expect(cp.runtime).toBe('node');
  });
});

describe('planDispatch', () => {
  const cp = controlPlaneDescriptor({ instanceId: 'cp1' });

  it('routable when ≥1 live worker is capable + protocol-compatible', () => {
    const plan = planDispatch(
      ['saga'],
      [worker({ instanceId: 'w1', capabilities: ['saga'] })],
      cp,
      'billing.charge',
    );
    expect(plan.status).toBe('routable');
    if (plan.status !== 'routable') throw new Error('unreachable');
    expect(plan.workers).toHaveLength(1);
  });

  it('blocked capability.unavailable when no live worker advertises the capability', () => {
    const plan = planDispatch(
      ['saga', 'search-attr-v2'],
      [worker({ instanceId: 'w1', capabilities: ['saga'] })],
      cp,
      'billing.charge',
    );
    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') throw new Error('unreachable');
    expect(plan.code).toBe('capability.unavailable');
    expect(plan.reason).toContain('search-attr-v2');
    expect(plan.diagnostics.missingCapabilities).toEqual(['search-attr-v2']);
  });

  it('blocked protocol.incompatible when a capable worker exists but every one is on an incompatible major', () => {
    const plan = planDispatch(
      ['saga'],
      [
        worker({
          instanceId: 'w1',
          capabilities: ['saga'],
          protocol: { version: 2, range: [2, 2] },
        }),
      ],
      cp,
      'billing.charge',
    );
    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') throw new Error('unreachable');
    expect(plan.code).toBe('protocol.incompatible');
    expect(plan.diagnostics.controlPlaneRange).toEqual([1, 1]);
    expect(plan.diagnostics.workerRanges).toEqual([[2, 2]]);
  });

  it('prefers a routable worker even when an incompatible one is also present', () => {
    const plan = planDispatch(
      ['saga'],
      [
        worker({
          instanceId: 'bad',
          capabilities: ['saga'],
          protocol: { version: 2, range: [2, 2] },
        }),
        worker({ instanceId: 'good', capabilities: ['saga'] }),
      ],
      cp,
      'billing.charge',
    );
    expect(plan.status).toBe('routable');
    if (plan.status !== 'routable') throw new Error('unreachable');
    expect(plan.workers.map((w) => w.instanceId)).toEqual(['good']);
  });

  it('no requirement still enforces protocol compatibility (a v2-only fleet blocks a v1 CP)', () => {
    const plan = planDispatch(
      [],
      [worker({ instanceId: 'w1', protocol: { version: 2, range: [2, 2] } })],
      cp,
      'billing.charge',
    );
    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') throw new Error('unreachable');
    expect(plan.code).toBe('protocol.incompatible');
  });
});
