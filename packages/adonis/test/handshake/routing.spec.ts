import { describe, expect, it } from 'vitest';
import type { RawWorkerDescriptor, WorkerDescriptor } from '../../src/handshake/descriptor.js';
import {
  type CapabilityRequirement,
  canRoute,
  capableWorkers,
  missingCapabilities,
  requiredCapabilities,
  resolveRouting,
} from '../../src/handshake/routing.js';

function worker(caps: string[], id = 'w'): WorkerDescriptor {
  return {
    instanceId: id,
    runtime: 'node',
    sdk: { name: 'sdk', version: '1.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: caps,
    workflows: [],
    steps: [],
    startedAt: 0,
  };
}

describe('requiredCapabilities — accepts both handler shapes', () => {
  it('reads a bare string[] requirement', () => {
    expect(requiredCapabilities(['saga', 'priority'])).toEqual(['saga', 'priority']);
  });
  it('reads a { requires } handler ref', () => {
    expect(requiredCapabilities({ requires: ['saga'] })).toEqual(['saga']);
  });
  it('treats an absent requires as no requirement', () => {
    expect(requiredCapabilities({})).toEqual([]);
  });
  it('de-duplicates', () => {
    expect(requiredCapabilities(['saga', 'saga'])).toEqual(['saga']);
  });
});

describe('canRoute — capability match (design §7.5)', () => {
  it('CAPABLE: worker advertises every required capability', () => {
    expect(canRoute(['saga', 'signals'], worker(['saga', 'signals', 'priority']))).toBe(true);
  });

  it('NOT CAPABLE: worker is missing a required capability', () => {
    expect(canRoute(['saga', 'search-attr-v2'], worker(['saga', 'signals']))).toBe(false);
  });

  it('a handler with no requirements routes anywhere', () => {
    expect(canRoute([], worker([]))).toBe(true);
    expect(canRoute({ requires: [] }, worker([]))).toBe(true);
  });

  it('missingCapabilities returns the precise delta', () => {
    expect(missingCapabilities(['saga', 'search-attr-v2', 'priority'], worker(['saga']))).toEqual([
      'search-attr-v2',
      'priority',
    ]);
    expect(missingCapabilities(['saga'], worker(['saga']))).toEqual([]);
  });
});

describe('canRoute — legacy worker backward-compat (design §7.7)', () => {
  const legacy: RawWorkerDescriptor = { instanceId: 'old', runtime: 'python' };

  it('a legacy worker can run baseline work (normalized to the v1 capability set)', () => {
    expect(canRoute(['saga'], legacy)).toBe(true);
    expect(canRoute(['signals'], legacy)).toBe(true);
    expect(canRoute([], legacy)).toBe(true);
  });

  it('a legacy worker cannot run work requiring a post-v1 capability', () => {
    expect(canRoute(['search-attr-v2'], legacy)).toBe(false);
  });
});

describe('capableWorkers — filter a fleet', () => {
  it('keeps only workers that can run the handler', () => {
    const fleet = [
      worker(['saga', 'signals'], 'a'),
      worker(['saga', 'search-attr-v2'], 'b'),
      worker([], 'c'),
    ];
    const capable = capableWorkers(['saga', 'search-attr-v2'], fleet);
    expect(capable.map((w) => w.instanceId)).toEqual(['b']);
  });
});

describe('resolveRouting — routable vs blocked (design §7.5)', () => {
  const handler: CapabilityRequirement = ['saga', 'search-attr-v2'];

  it('ROUTABLE: returns the capable subset when at least one worker can run it', () => {
    const fleet = [worker(['saga'], 'a'), worker(['saga', 'search-attr-v2'], 'b')];
    const res = resolveRouting(handler, fleet);
    expect(res.status).toBe('routable');
    if (res.status === 'routable') {
      expect(res.workers.map((w) => w.instanceId)).toEqual(['b']);
      expect(res.requires).toEqual(['saga', 'search-attr-v2']);
    }
  });

  it('BLOCKED: no capable worker → precise dashboard reason string', () => {
    const fleet = [worker(['saga'], 'a'), worker(['signals'], 'b')];
    const res = resolveRouting(handler, fleet);
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') {
      expect(res.reason).toBe('blocked: no compatible worker (requires saga, search-attr-v2)');
      expect(res.requires).toEqual(['saga', 'search-attr-v2']);
    }
  });

  it('BLOCKED: an empty fleet always blocks (never a silent hang)', () => {
    const res = resolveRouting(handler, []);
    expect(res.status).toBe('blocked');
  });

  it('a no-requirement handler is routable to any live worker (reason has no "requires" suffix)', () => {
    const res = resolveRouting([], [worker([], 'a')]);
    expect(res.status).toBe('routable');
    const blocked = resolveRouting([], []);
    expect(blocked.status).toBe('blocked');
    if (blocked.status === 'blocked') {
      expect(blocked.reason).toBe('blocked: no compatible worker');
    }
  });
});
