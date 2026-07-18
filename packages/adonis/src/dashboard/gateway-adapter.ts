import type { RunResult } from '../interfaces.js';
import { DURABLE_RUN_GATEWAY } from '../role_bindings.js';
import type { RunGateway } from '../run-gateway/interface.js';
import type { DashboardEngine } from './handlers.js';

/**
 * Adapt a {@link RunGateway} to the {@link DashboardEngine} port the JSON handlers drive, so a
 * **store-less `tenant` pod** serves the SAME dashboard over the wire (design §8) — every read/control
 * verb round-trips through the pod's `ProxyRunGateway` to the control plane, with NO local store or
 * engine. Store presence stays invisible above the handler line.
 *
 * The gateway is a near-superset of the port; two verbs need bridging:
 * - `listCheckpoints` → the gateway's `getCheckpoints` (same shape, §8 naming);
 * - `requeue` → the gateway's `redispatchPending` (the operator recovery verb; the extra
 *   `redispatched` count on the result is a harmless superset of `RunResult`).
 *
 * `getRunChildren` (parent→child fan-out) now rides the P4 read surface too (a `getRunChildren`
 * `RunRequestKind` verb), so a store-less tenant pod's run detail view lists children round-tripped over
 * the wire — the responder enforces the tenant-ownership check before answering (anti-IDOR).
 */
export function gatewayDashboardEngine(gateway: RunGateway): DashboardEngine {
  return {
    getRun: (runId) => gateway.getRun(runId),
    listRuns: (query) => gateway.listRuns(query),
    listCheckpoints: (runId) => gateway.getCheckpoints(runId),
    getRunChildren: (runId) => gateway.getRunChildren(runId),
    requeue: (runId): Promise<RunResult | null> => gateway.redispatchPending(runId),
    cancel: (runId, opts) => gateway.cancel(runId, opts),
    workerHealth: () => gateway.workerHealth(),
  };
}

/** The minimal container surface {@link dashboardEngineForRole} resolves bindings through. */
export interface DashboardContainer {
  make(key: unknown): Promise<unknown>;
}

/**
 * Resolve the dashboard's read/control port for the active durable `role` (design §5) — the single seam
 * that makes the dashboard store-agnostic:
 *
 * - **`tenant`** (store-less): resolve the {@link DURABLE_RUN_GATEWAY} token (a `ProxyRunGateway`) and
 *   adapt it — the engine binding is deliberately ABSENT on a tenant pod (structural isolation), so we
 *   MUST NOT reach for `WorkflowEngine` here;
 * - **store roles** (`standalone`/`control-plane`): resolve the concrete `WorkflowEngine` (structurally a
 *   {@link DashboardEngine}) exactly as before — behavior byte-for-byte unchanged.
 *
 * `engineToken` is injected (rather than imported) so the module doesn't hard-depend on the engine class
 * for the tenant path — the tenant branch never touches it.
 */
export async function dashboardEngineForRole(
  role: 'standalone' | 'control-plane' | 'tenant',
  container: DashboardContainer,
  engineToken: unknown,
): Promise<DashboardEngine> {
  if (role === 'tenant') {
    const gateway = (await container.make(DURABLE_RUN_GATEWAY)) as RunGateway;
    return gatewayDashboardEngine(gateway);
  }
  return (await container.make(engineToken)) as DashboardEngine;
}
