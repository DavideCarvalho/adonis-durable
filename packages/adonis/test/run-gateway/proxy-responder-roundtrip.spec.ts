import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  EngineEvent,
  RunReply,
  RunRequest,
  StartRunMessage,
  TenantEvent,
} from '../../src/interfaces.js';
import type { ProxyTransport } from '../../src/run-gateway/proxy-run-gateway.js';
import { ProxyRunGateway } from '../../src/run-gateway/proxy-run-gateway.js';
import type { ResponderTransport } from '../../src/run-gateway/run-request-responder.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { hmacTenantVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A single-process in-memory P4 transport wiring a {@link ProxyRunGateway} (tenant side) to a
 * {@link RunRequestResponder} (control-plane side): a `dispatch*` on the tenant side is delivered
 * straight to the responder's consumer, whose reply is fanned back to every `onRunReply`/`onTenantEvent`
 * listener — so the FULL round-trip runs with no Redis. Failure injection (`dropRequests`, `failDispatch`)
 * proves the proxy's fail-fast paths.
 */
class FakeP4Transport implements ProxyTransport, ResponderTransport {
  #onStartRun: ((msg: StartRunMessage) => Promise<void>) | undefined;
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  readonly #replyHandlers = new Set<(r: RunReply) => void>();
  readonly #tenantHandlers = new Map<string, Set<(e: TenantEvent) => void>>();

  /** Swallow a dispatch without delivering it to the responder — models a down/silent control plane. */
  dropRequests = false;
  /** Make a dispatch throw — models a transport-level failure. */
  failDispatch = false;

  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    if (this.failDispatch) throw new Error('transport unavailable');
    if (this.dropRequests) return;
    await this.#onStartRun?.(msg);
  }
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    if (this.failDispatch) throw new Error('transport unavailable');
    if (this.dropRequests) return;
    await this.#onRunRequest?.(msg);
  }
  onRunReply(handler: (reply: RunReply) => void): void {
    this.#replyHandlers.add(handler);
  }
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    let set = this.#tenantHandlers.get(tenant);
    if (!set) {
      set = new Set();
      this.#tenantHandlers.set(tenant, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.#onStartRun = handler;
  }
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#onRunRequest = handler;
  }
  async publishRunReply(reply: RunReply): Promise<void> {
    for (const h of this.#replyHandlers) h(reply);
  }
  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    for (const h of this.#tenantHandlers.get(evt.tenant) ?? []) h(evt);
  }
}

function makeEngine(namespace: string): WorkflowEngine {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore(), namespace });
  engine.register('echo', '1', async (_ctx, input) => input);
  engine.register('await-go', '1', async (ctx) => ctx.waitForSignal('go'));
  engine.register('stepper', '1', async (ctx) => ctx.localStep('do-it', async () => 'stepped'));
  return engine;
}

/**
 * Wire a control plane (engine + StoreRunGateway + responder) onto `transport`. The engine is stamped
 * with `namespace` (default the primary test tenant `acme`) so it ALSO executes that tenant's runs in
 * this single process — in a real cluster a store-less acme WORKER pod would; here the coordinator
 * doubles as it, letting a run actually run to completion so the read/control verbs have real state.
 */
function wireControlPlane(
  transport: FakeP4Transport,
  options: { verify?: ReturnType<typeof hmacTenantVerifier>; namespace?: string } = {},
): WorkflowEngine {
  const engine = makeEngine(options.namespace ?? 'acme');
  const gateway = new StoreRunGateway(engine, { role: 'control-plane' });
  const responder = new RunRequestResponder(transport, gateway, {
    ...(options.verify ? { verifyTenant: options.verify } : {}),
    subscribeEngineEvents: (listener) => engine.subscribe(listener),
  });
  responder.start();
  return engine;
}

describe('ProxyRunGateway ↔ RunRequestResponder round-trip (prefix-only, no token)', () => {
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;
  let proxy: ProxyRunGateway;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport);
    proxy = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 500 });
  });

  it('topology() reports the tenant role + partition — synchronous, no round-trip', () => {
    expect(proxy.topology()).toEqual({ role: 'tenant', tenant: 'acme' });
  });

  it('start() round-trips a StartRunMessage and the control plane stamps the run with the tenant namespace', async () => {
    const started = await proxy.start('echo', { hello: 'world' });
    expect(started.runId).toBeTruthy();
    const settled = await engine.waitForRun(started.runId);
    expect(settled.status).toBe('completed');

    // The responder FORCED the run's namespace to the requester's tenant.
    const run = await proxy.getRun(started.runId);
    expect(run?.namespace).toBe('acme');
    expect(run?.workflow).toBe('echo');
  });

  it('getCheckpoints round-trips the run timeline', async () => {
    const started = await proxy.start('stepper', {});
    await engine.waitForRun(started.runId);
    const checkpoints = await proxy.getCheckpoints(started.runId);
    expect(checkpoints.some((c) => c.name === 'do-it')).toBe(true);
  });

  it('signal round-trips and resumes a parked run', async () => {
    const started = await proxy.start('await-go', {});
    // Deliver the signal over the wire; the run resumes and completes with the payload.
    await proxy.signal(started.runId, 'go', { delivered: true });
    const settled = await engine.waitForRun(started.runId);
    expect(settled.status).toBe('completed');
    expect(settled.output).toEqual({ delivered: true });
  });

  it('cancel round-trips and cancels the run', async () => {
    const started = await proxy.start('await-go', {});
    const result = await proxy.cancel(started.runId);
    expect(result?.status).toBe('cancelled');
  });

  it('listRuns is scoped to the requester tenant even when other tenants have runs', async () => {
    // A second tenant on the SAME control plane. Its run stamps namespace `globex`; the engine (an
    // `acme` node here) doesn't execute it, but it IS persisted — enough to prove listRuns scoping.
    const other = new ProxyRunGateway(transport, { partition: 'globex', requestTimeoutMs: 500 });
    const acmeRun = await proxy.start('echo', { who: 'acme' });
    const globexRun = await other.start('echo', { who: 'globex' });

    const acmeList = await proxy.listRuns({});
    const globexList = await other.listRuns({});
    expect(acmeList.map((r) => r.id)).toEqual([acmeRun.runId]);
    expect(globexList.map((r) => r.id)).toEqual([globexRun.runId]);
  });

  it('subscribe live-tails the tenant’s own run over the tenant-events channel', async () => {
    // Park a run, THEN subscribe, so the resume/completion events arrive after the subscription.
    const started = await proxy.start('await-go', {});
    const events: EngineEvent[] = [];
    const off = proxy.subscribe(started.runId, (e) => events.push(e));
    await proxy.signal(started.runId, 'go', { done: true });
    await engine.waitForRun(started.runId);
    off();
    expect(events.some((e) => e.runId === started.runId && e.type === 'run.completed')).toBe(true);
    // Never another run's events (filtered by runId in subscribe()).
    expect(events.every((e) => e.runId === started.runId)).toBe(true);
  });
});

describe('tenant boundary — anti-IDOR (spec §8/§9)', () => {
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;
  let acme: ProxyRunGateway;
  let evil: ProxyRunGateway;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport);
    acme = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 500 });
    evil = new ProxyRunGateway(transport, { partition: 'evil', requestTimeoutMs: 500 });
  });

  it('a tenant cannot READ another tenant’s run (getRun rejects cross-tenant)', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.getRun(started.runId)).rejects.toThrow(/another tenant/);
  });

  it('a tenant cannot CANCEL another tenant’s run (cancel rejects, run untouched)', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.cancel(started.runId)).rejects.toThrow(/another tenant/);
    // Proof the run was never touched: acme's own cancel still succeeds afterwards.
    const result = await acme.cancel(started.runId);
    expect(result?.status).toBe('cancelled');
  });

  it('a tenant cannot SIGNAL another tenant’s run', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.signal(started.runId, 'go', {})).rejects.toThrow(/another tenant/);
  });

  it('an unknown run is not an error (returns null), so it leaks nothing about existence', async () => {
    await expect(evil.getRun('does-not-exist')).resolves.toBeNull();
  });
});

describe('layered tenant auth over the round-trip (signed token, spec §9)', () => {
  const SECRET = 'round-trip-secret';
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport, { verify: hmacTenantVerifier(SECRET) });
  });

  it('a validly-signed pod starts + reads its runs; the tenant is DERIVED from the token', async () => {
    const proxy = new ProxyRunGateway(transport, {
      partition: 'acme',
      token: signTenantToken('acme', SECRET),
      requestTimeoutMs: 500,
    });
    const started = await proxy.start('echo', { ok: true });
    await engine.waitForRun(started.runId);
    const run = await proxy.getRun(started.runId);
    expect(run?.namespace).toBe('acme'); // derived from the verified token, not the body
  });

  it('a pod presenting a token signed with the WRONG secret is rejected (unauthorized)', async () => {
    const forged = new ProxyRunGateway(transport, {
      partition: 'acme',
      token: signTenantToken('acme', 'the-wrong-secret'),
      requestTimeoutMs: 500,
    });
    await expect(forged.start('echo', {})).rejects.toThrow(/unauthorized|invalid/i);
  });

  it('a pod whose token claim was tampered cannot impersonate another tenant', async () => {
    const good = signTenantToken('acme', SECRET);
    const [, sig] = good.split('.');
    const impersonator = new ProxyRunGateway(transport, {
      partition: 'globex',
      token: `globex.${sig}`, // acme's signature over a globex claim
      requestTimeoutMs: 500,
    });
    await expect(impersonator.listRuns({})).rejects.toThrow(/unauthorized|invalid/i);
  });
});

describe('proxy fail-fast (spec §8)', () => {
  it('rejects with a clear timeout error when the control plane never replies', async () => {
    const transport = new FakeP4Transport();
    wireControlPlane(transport);
    transport.dropRequests = true; // control plane "down": request delivered nowhere
    const proxy = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 30 });
    await expect(proxy.getRun('r1')).rejects.toThrow(/did not answer getRun within 30ms/);
  });

  it('rejects immediately when the transport dispatch itself fails', async () => {
    const transport = new FakeP4Transport();
    wireControlPlane(transport);
    transport.failDispatch = true;
    const proxy = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 5_000 });
    await expect(proxy.listRuns({})).rejects.toThrow(/transport unavailable/);
  });
});
