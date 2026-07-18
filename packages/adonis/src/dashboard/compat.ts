import { controlPlaneDescriptor } from '../dispatch-routing.js';
import type { WorkerDescriptor } from '../handshake/descriptor.js';
import { negotiate } from '../handshake/negotiate.js';
import type { WorkflowRun } from '../interfaces.js';
import type { RecordedBlock } from './diagnostics-recorder.js';
import { type ApiResponse, ok } from './handlers.js';

/**
 * The data source the {@link compat} health/compat handler reads (design §10). Deliberately a thin,
 * framework-light port so the handler is unit-testable with fakes:
 *
 * - `controlPlaneDescriptor()` — the control plane's own handshake descriptor, negotiated against each
 *   worker; `undefined` when nothing has advertised yet (the handler falls back to a current-protocol CP);
 * - `fleet()` — live worker descriptors grouped by routing token (from `listWorkerDescriptors` on a store
 *   role, reconstructed from diagnostics events by {@link BlockedDiagnosticsRecorder});
 * - `blockedRuns()` — the runs parked `blocked` (their human reason on `run.error.message`);
 * - `diagnosticsFor(runId)` — the captured loud delta for a blocked run, when one was recorded.
 *
 * The SAME handler serves a store-less `tenant` pod: there `fleet()` is empty and `diagnosticsFor` returns
 * nothing, so the panel still lists blocked runs (reason-only) round-tripped over the wire.
 */
export interface CompatSource {
  controlPlaneDescriptor(): WorkerDescriptor | undefined;
  fleet(): Array<{ token: string; workers: WorkerDescriptor[] }>;
  blockedRuns(): Promise<WorkflowRun[]>;
  diagnosticsFor(runId: string): RecordedBlock | undefined;
}

/**
 * `GET /compat` — the fleet health / protocol-compatibility panel (design §7.6, §10).
 *
 * Two sections, both LOUD and structured (never a bare boolean):
 * 1. **Per queue/group/pod compatibility** — every live worker descriptor negotiated against the control
 *    plane: its protocol version + the negotiated level, plus a red flag + the exact reason when
 *    incompatible ("no common protocol major: local speaks [1, 1], remote speaks [2, 2]").
 * 2. **Blocked runs** — runs parked because no worker can run them, each with its human reason and, when
 *    captured, the `capability.unavailable` / `protocol.incompatible` diagnostics delta (missing
 *    capabilities, the protocol ranges that failed to overlap).
 */
export async function compat(src: CompatSource): Promise<ApiResponse> {
  // Fall back to a current-protocol CP descriptor so pods can still be negotiated before the CP has
  // advertised (or on a topology that never publishes one).
  const cp =
    src.controlPlaneDescriptor() ?? controlPlaneDescriptor({ instanceId: 'control-plane' });

  const groups = src.fleet().map(({ token, workers }) => {
    const pods = workers.map((worker) => {
      const result = negotiate(cp, worker);
      return {
        instanceId: worker.instanceId,
        runtime: worker.runtime,
        sdk: worker.sdk,
        protocol: worker.protocol.version,
        protocolRange: worker.protocol.range,
        capabilities: worker.capabilities,
        outcome: result.outcome,
        negotiatedProtocol: result.negotiatedProtocol,
        incompatible: result.outcome === 'incompatible',
        // The red-flag reason: precise, structured copy for the panel (design §7.6). Absent when compatible.
        reason: result.reason?.message,
        missingOnRemote: result.capabilities.missingOnRemote,
        missingOnLocal: result.capabilities.missingOnLocal,
      };
    });
    return {
      token,
      pods,
      incompatible: pods.some((pod) => pod.incompatible),
      degraded: pods.some((pod) => pod.outcome === 'degraded'),
    };
  });

  const blocked = (await src.blockedRuns()).map((run) => {
    const recorded = src.diagnosticsFor(run.id);
    return {
      id: run.id,
      workflow: run.workflow,
      namespace: run.namespace,
      status: run.status,
      // Human reason: the persisted run error (always set when parked), or the captured delta's copy.
      reason: run.error?.message ?? recorded?.reason ?? 'blocked',
      code: recorded?.code,
      requires: recorded?.diagnostics.requires ?? [],
      // The structured delta (design §7.6), when a diagnostics event was captured for this run.
      token: recorded?.diagnostics.token,
      missingCapabilities: recorded?.diagnostics.missingCapabilities,
      controlPlaneRange: recorded?.diagnostics.controlPlaneRange,
      workerRanges: recorded?.diagnostics.workerRanges,
      updatedAt: run.updatedAt.toISOString(),
    };
  });

  const incompatibleCount = groups.reduce(
    (n, group) => n + group.pods.filter((pod) => pod.incompatible).length,
    0,
  );

  return ok({
    controlPlane: {
      instanceId: cp.instanceId,
      protocol: cp.protocol.version,
      protocolRange: cp.protocol.range,
      capabilities: cp.capabilities,
    },
    groups,
    blocked,
    incompatibleCount,
    blockedCount: blocked.length,
  });
}
