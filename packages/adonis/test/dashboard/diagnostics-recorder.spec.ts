import { describe, expect, it } from 'vitest';
import { BlockedDiagnosticsRecorder } from '../../src/dashboard/diagnostics-recorder.js';
import type { DispatchDiagnostics } from '../../src/dispatch-routing.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type { EngineEvent } from '../../src/interfaces.js';

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

function blockEvent(
  runId: string,
  over: Partial<DispatchDiagnostics> = {},
  type: 'capability.unavailable' | 'protocol.incompatible' = 'capability.unavailable',
): EngineEvent {
  const diagnostics: DispatchDiagnostics = {
    code: type,
    token: 'billing@acme',
    requires: ['saga'],
    liveWorkers: 1,
    missingCapabilities: ['saga'],
    controlPlane: worker({ instanceId: 'cp' }),
    workers: [worker({ instanceId: 'w1', capabilities: ['signals'] })],
    ...over,
  };
  return {
    type,
    runId,
    workflow: 'checkout',
    error: {
      message: `blocked: no compatible worker (requires ${diagnostics.requires.join(', ')})`,
      retryable: true,
    },
    diagnostics,
    at: new Date('2026-07-17T00:00:00Z'),
  };
}

describe('BlockedDiagnosticsRecorder', () => {
  it('captures a diagnostics event and joins it back by runId', () => {
    const r = new BlockedDiagnosticsRecorder();
    r.record(blockEvent('run-1'));
    const got = r.diagnosticsFor('run-1');
    expect(got?.code).toBe('capability.unavailable');
    expect(got?.reason).toContain('requires saga');
    expect(got?.diagnostics.missingCapabilities).toEqual(['saga']);
  });

  it('reconstructs the live-fleet view + control-plane descriptor from the event', () => {
    const r = new BlockedDiagnosticsRecorder();
    r.record(
      blockEvent('run-1', { token: 'billing@acme', workers: [worker({ instanceId: 'w1' })] }),
    );
    r.record(
      blockEvent('run-2', { token: 'billing@acme', workers: [worker({ instanceId: 'w2' })] }),
    );
    const fleet = r.fleet();
    const group = fleet.find((f) => f.token === 'billing@acme');
    expect(group?.workers.map((w) => w.instanceId).sort()).toEqual(['w1', 'w2']);
    expect(r.controlPlaneDescriptor()?.instanceId).toBe('cp');
  });

  it('ignores non-diagnostics events', () => {
    const r = new BlockedDiagnosticsRecorder();
    r.record({ type: 'run.completed', runId: 'run-1', at: new Date() });
    expect(r.diagnosticsFor('run-1')).toBeUndefined();
    expect(r.fleet()).toEqual([]);
  });

  it('drops the diagnostics payload-less event (never a bare boolean)', () => {
    const r = new BlockedDiagnosticsRecorder();
    r.record({ type: 'capability.unavailable', runId: 'run-x', at: new Date() });
    expect(r.diagnosticsFor('run-x')).toBeUndefined();
  });

  it('bounds the per-run index, evicting the oldest', () => {
    const r = new BlockedDiagnosticsRecorder({ max: 2 });
    r.record(blockEvent('a'));
    r.record(blockEvent('b'));
    r.record(blockEvent('c'));
    expect(r.diagnosticsFor('a')).toBeUndefined(); // evicted
    expect(r.diagnosticsFor('b')).toBeDefined();
    expect(r.diagnosticsFor('c')).toBeDefined();
  });

  it('attach() subscribes and returns an unsubscribe that stops recording', () => {
    const listeners = new Set<(e: EngineEvent) => void>();
    const source = {
      subscribe(l: (e: EngineEvent) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const r = new BlockedDiagnosticsRecorder();
    const detach = r.attach(source);
    for (const l of listeners) l(blockEvent('run-1'));
    expect(r.diagnosticsFor('run-1')).toBeDefined();
    detach();
    for (const l of listeners) l(blockEvent('run-2'));
    expect(r.diagnosticsFor('run-2')).toBeUndefined();
  });
});
