import { describe, expect, it } from 'vitest';
import {
  dashboardEngineForRole,
  gatewayDashboardEngine,
} from '../../src/dashboard/gateway-adapter.js';
import { WorkflowEngine } from '../../src/engine.js';
import { DURABLE_RUN_GATEWAY } from '../../src/role_bindings.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';

/** A RunGateway spy that records which verbs the adapter routes to it. */
function gatewaySpy(): RunGateway & { calls: string[] } {
  const calls: string[] = [];
  const track = <T>(label: string, value: T): T => {
    calls.push(label);
    return value;
  };
  return {
    calls,
    topology: () => ({ role: 'tenant', tenant: 'acme' }),
    getRun: async (id) => track(`getRun:${id}`, null),
    listRuns: async () => track('listRuns', []),
    getCheckpoints: async (id) => track(`getCheckpoints:${id}`, []),
    getSearchAttributes: async () => undefined,
    workerHealth: async () => track('workerHealth', []),
    start: async () => ({ runId: 'r', status: 'pending' }),
    signal: async () => null,
    cancel: async (id) => track(`cancel:${id}`, null),
    redispatchPending: async (id) => track(`redispatch:${id}`, null),
    subscribe: () => () => {},
  };
}

describe('gatewayDashboardEngine — RunGateway → DashboardEngine port', () => {
  it('maps listCheckpoints → getCheckpoints and requeue → redispatchPending', async () => {
    const gw = gatewaySpy();
    const engine = gatewayDashboardEngine(gw);

    await engine.listCheckpoints('run-1');
    await engine.requeue('run-1');
    await engine.cancel('run-1');
    await engine.workerHealth();
    await engine.listRuns({ limit: 10, offset: 0 });

    expect(gw.calls).toContain('getCheckpoints:run-1');
    expect(gw.calls).toContain('redispatch:run-1'); // requeue routed to the proxy recovery verb
    expect(gw.calls).toContain('cancel:run-1');
    expect(gw.calls).toContain('workerHealth');
    expect(gw.calls).toContain('listRuns');
  });

  it('degrades getRunChildren to [] over the wire (not part of the P4 read surface)', async () => {
    const engine = gatewayDashboardEngine(gatewaySpy());
    expect(await engine.getRunChildren('run-1')).toEqual([]);
  });
});

/** A key-aware container double: an unbound key throws — exactly how we prove a tenant dashboard never
 *  reaches for the (absent) engine binding. */
function containerWith(bindings: Map<unknown, unknown>) {
  const touched: unknown[] = [];
  return {
    touched,
    async make(key: unknown) {
      touched.push(key);
      if (!bindings.has(key)) throw new Error(`no binding for ${String(key)}`);
      return bindings.get(key);
    },
  };
}

describe('dashboardEngineForRole — role-branched resolution', () => {
  it('tenant: resolves the DURABLE_RUN_GATEWAY token and NEVER touches WorkflowEngine (store-less)', async () => {
    const gw = gatewaySpy();
    // Only the gateway is bound — the engine token is deliberately ABSENT (tenant structural isolation).
    const container = containerWith(new Map<unknown, unknown>([[DURABLE_RUN_GATEWAY, gw]]));

    const engine = await dashboardEngineForRole('tenant', container, WorkflowEngine);
    // The returned port delegates to the gateway (proving it IS the proxy, not an engine).
    await engine.listRuns({ limit: 5, offset: 0 });
    expect(gw.calls).toContain('listRuns');

    // The KEY isolation assertion: it resolved the gateway token, and never asked for WorkflowEngine.
    expect(container.touched).toContain(DURABLE_RUN_GATEWAY);
    expect(container.touched).not.toContain(WorkflowEngine);
  });

  it('store role: resolves WorkflowEngine directly (behavior unchanged)', async () => {
    const fakeEngine = { marker: 'engine' };
    const container = containerWith(new Map<unknown, unknown>([[WorkflowEngine, fakeEngine]]));

    const resolved = await dashboardEngineForRole('standalone', container, WorkflowEngine);
    expect(resolved).toBe(fakeEngine);
    expect(container.touched).toContain(WorkflowEngine);
    expect(container.touched).not.toContain(DURABLE_RUN_GATEWAY);
  });
});
