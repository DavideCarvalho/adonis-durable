import { describe, expect, it } from 'vitest';
import {
  LEGACY_V1_CAPABILITIES,
  type RawWorkerDescriptor,
  type WorkerDescriptor,
} from '../../src/handshake/descriptor.js';
import { negotiate } from '../../src/handshake/negotiate.js';

function desc(overrides: Partial<WorkerDescriptor> = {}): WorkerDescriptor {
  return {
    instanceId: 'i',
    runtime: 'node',
    sdk: { name: 'sdk', version: '1.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: ['saga', 'signals'],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...overrides,
  };
}

describe('negotiate — three outcomes (design §7.4)', () => {
  it('COMPATIBLE: ranges overlap + full capability parity → no reason', () => {
    const r = negotiate(desc(), desc());
    expect(r.outcome).toBe('compatible');
    expect(r.reason).toBeUndefined();
    expect(r.negotiatedProtocol).toBe(1);
    expect(r.capabilities.shared).toEqual(['saga', 'signals']);
    expect(r.capabilities.missingOnRemote).toEqual([]);
    expect(r.capabilities.missingOnLocal).toEqual([]);
  });

  it('DEGRADED: ranges overlap but remote lacks an optional capability the local has', () => {
    const local = desc({ capabilities: ['saga', 'signals', 'priority'] });
    const remote = desc({ capabilities: ['saga', 'signals'] });
    const r = negotiate(local, remote);
    expect(r.outcome).toBe('degraded');
    expect(r.reason?.code).toBe('capability.unavailable');
    expect(r.capabilities.missingOnRemote).toEqual(['priority']);
    expect(r.capabilities.missingOnLocal).toEqual([]);
    expect(r.negotiatedProtocol).toBe(1);
  });

  it('DEGRADED: ranges overlap but local lacks a capability the remote has', () => {
    const local = desc({ capabilities: ['saga'] });
    const remote = desc({ capabilities: ['saga', 'signals'] });
    const r = negotiate(local, remote);
    expect(r.outcome).toBe('degraded');
    expect(r.capabilities.missingOnLocal).toEqual(['signals']);
    expect(r.reason?.detail.missingOnLocal).toEqual(['signals']);
  });

  it('DEGRADED: a REQUIRED capability the remote lacks (routing parks the specific run)', () => {
    const local = desc({ capabilities: ['saga', 'signals'] });
    const remote = desc({ capabilities: ['saga', 'signals'] });
    const r = negotiate(local, remote, { required: ['search-attr-v2'] });
    expect(r.outcome).toBe('degraded');
    expect(r.reason?.code).toBe('capability.unavailable');
    expect(r.reason?.detail.missingRequired).toEqual(['search-attr-v2']);
  });

  it('a required capability present on BOTH sides stays compatible', () => {
    const both = desc({ capabilities: ['saga', 'signals', 'search-attr-v2'] });
    const r = negotiate(both, both, { required: ['search-attr-v2'] });
    expect(r.outcome).toBe('compatible');
  });

  it('INCOMPATIBLE: no protocol-range overlap → protocol.incompatible + exact ranges', () => {
    const local = desc({ protocol: { version: 1, range: [1, 1] } });
    const remote = desc({ protocol: { version: 2, range: [2, 2] } });
    const r = negotiate(local, remote);
    expect(r.outcome).toBe('incompatible');
    expect(r.negotiatedProtocol).toBeNull();
    expect(r.reason?.code).toBe('protocol.incompatible');
    expect(r.reason?.detail.localRange).toEqual([1, 1]);
    expect(r.reason?.detail.remoteRange).toEqual([2, 2]);
  });

  it('protocol takes precedence: no overlap is incompatible even with full capability parity', () => {
    const local = desc({ protocol: { version: 1, range: [1, 1] }, capabilities: ['saga'] });
    const remote = desc({ protocol: { version: 3, range: [3, 3] }, capabilities: ['saga'] });
    expect(negotiate(local, remote).outcome).toBe('incompatible');
  });
});

describe('negotiate — negotiated protocol major (design §7.3)', () => {
  it('picks the highest common major when ranges overlap on a band', () => {
    const local = desc({ protocol: { version: 2, range: [1, 2] } });
    const remote = desc({ protocol: { version: 3, range: [1, 3] } });
    const r = negotiate(local, remote);
    expect(r.outcome).toBe('compatible');
    expect(r.negotiatedProtocol).toBe(2); // min of the two highs
  });

  it('touching ranges (share exactly one major) overlap', () => {
    const local = desc({ protocol: { version: 2, range: [1, 2] } });
    const remote = desc({ protocol: { version: 2, range: [2, 3] } });
    const r = negotiate(local, remote);
    expect(r.outcome).toBe('compatible');
    expect(r.negotiatedProtocol).toBe(2);
  });
});

describe('negotiate — bilateral symmetry (design §7.3)', () => {
  it('outcome is symmetric for the capability-parity path (compatible)', () => {
    const a = desc({ capabilities: ['saga', 'signals'] });
    const b = desc({ capabilities: ['saga', 'signals'] });
    expect(negotiate(a, b).outcome).toBe(negotiate(b, a).outcome);
  });

  it('outcome is symmetric for a mismatch; the missing-delta swaps sides', () => {
    const a = desc({ capabilities: ['saga', 'signals', 'priority'] });
    const b = desc({ capabilities: ['saga', 'signals'] });
    const ab = negotiate(a, b);
    const ba = negotiate(b, a);
    expect(ab.outcome).toBe('degraded');
    expect(ba.outcome).toBe('degraded');
    expect(ab.capabilities.missingOnRemote).toEqual(ba.capabilities.missingOnLocal);
    expect(ab.capabilities.missingOnLocal).toEqual(ba.capabilities.missingOnRemote);
  });

  it('incompatible is symmetric', () => {
    const a = desc({ protocol: { version: 1, range: [1, 1] } });
    const b = desc({ protocol: { version: 2, range: [2, 2] } });
    expect(negotiate(a, b).outcome).toBe(negotiate(b, a).outcome);
  });
});

describe('negotiate — legacy assume-compatible (design §7.7)', () => {
  it('a legacy peer (no protocol/capabilities) negotiates as compatible v1', () => {
    const modern: RawWorkerDescriptor = {
      instanceId: 'cp',
      runtime: 'node',
      protocol: { version: 1, range: [1, 1] },
      // a v1 control-plane advertises the v1 surface — same set a legacy peer normalizes to
      capabilities: [...LEGACY_V1_CAPABILITIES],
    };
    const legacy: RawWorkerDescriptor = { instanceId: 'old-worker', runtime: 'python' };
    const r = negotiate(modern, legacy);
    expect(r.outcome).toBe('compatible');
    expect(r.negotiatedProtocol).toBe(1);
  });

  it('two legacy peers are compatible', () => {
    const r = negotiate(
      { instanceId: 'a', runtime: 'node' },
      { instanceId: 'b', runtime: 'python' },
    );
    expect(r.outcome).toBe('compatible');
  });
});
