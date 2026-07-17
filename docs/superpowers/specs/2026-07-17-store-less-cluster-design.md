# Store-less durable cluster + cross-ecosystem interop — design

**Date:** 2026-07-17
**Repo:** `adonis-durable` (`@adonis-agora/durable`) — primary. Cross-repo: `nestjs-durable` (aviary) + Python client.
**Status:** design approved (brainstorming), pending implementation plan.

## 1. Goal

Bring the aviary durable cluster model to Agora: separate **API from engine**, run **store-less "thin" pods that only talk to the control plane**, route work **per tenant**, and let a **Python worker** (built on the aviary durable lib) and an Adonis worker share the **same control plane**. All four drivers are in scope: independent scaling, isolation/security, tenant routing, thin/polyglot workers.

The wire protocol MUST match aviary **byte-for-byte** (a Python aviary worker interoperates unchanged). Only the app-facing `config/durable.ts` ergonomics stay Adonis-idiomatic.

## 2. What already exists (do not rebuild)

Verified against current `packages/adonis/src`:
- **ControlPlane** — interface + `RedisControlPlane` are already byte-compatible with the aviary BullMQ control channel (`${prefix}-control`, JSON `ControlMessage`). A mixed Adonis+Nest+Python fleet already shares it.
- **DTOs** — `RemoteTask`, `StepResult`, `Heartbeat`, `StepError`, `WorkflowTask`, `WorkflowDecision` match aviary field-for-field, including `stepId = ${runId}:${seq}`. `protocol.ts runStepHandler` is the shared, pure worker body.
- **API/engine split seam** — the engine already takes a `runDispatcher`; a no-op one makes `start()` durably enqueue without driving. A non-HTTP worker entrypoint exists (`node ace durable:work`).
- **Namespace/partition on the wire** — `<name>@<tenant>` routing tokens already exist (`tenant-group.ts`).

The delta is: a new aviary-compatible **BullMQ transport**, the **P4 request/reply** protocol + **RunGateway**, a **store-less WorkerRuntime**, the **handshake/negotiation** layer, and **role-branched boot**.

## 3. Roles & topology

Explicit `role`, selected in config (not inferred). Default reproduces today's single-process behavior.

| Role | Store | Executes bodies | Serves HTTP | RunGateway |
|------|-------|-----------------|-------------|------------|
| `standalone` (default) | ✅ | ✅ (embedded worker) | optional | Store |
| `control-plane` | ✅ | ❌ (dispatch/recover/timers/respond only) | optional | Store |
| `tenant` (worker) | ❌ | ✅ (consumes tasks) | ❌ | Proxy |
| `tenant` (api/dashboard) | ❌ | ❌ | ✅ | Proxy |

- **`standalone`** = control-plane **+ embedded worker** in one process. All work is still durable (dispatch→checkpoint); the difference from `control-plane` is only *where the worker executing the bodies lives* (same process vs separate pod). There is no "inline" execution — every `ctx.step` is dispatched + checkpointed; only `ctx.localStep` runs in-process for trivial non-durable side-effects.
- **`control-plane`** = pure coordinator: owns store, dispatches, recovers, timers, retention, hosts the `RunRequestResponder`. No embedded worker.
- **`tenant`** = store-less. Its shape is decided by the **entrypoint launched**, not config:
  - **worker** → `node ace durable:worker` (store-less task-consumer loop). Registers `app/workflows`+`app/steps`, subscribes their `<name>@<tenant>` queues, advertises them in its descriptor.
  - **api/dashboard** → the HTTP server (`node bin/server.js`); every read/control/start round-trips over the wire via `ProxyRunGateway`.
  - both → run both processes (less isolated; usually kept separate).

Worker-vs-api is an implicit entrypoint distinction (AdonisJS already separates `serve` from ace commands). No extra config field.

**Axes:** `namespace` = control-plane poll-scope + key prefix. `partition`/tenant = `<name>@<tenant>` queue suffix.

## 4. Structure: two faithful objects (not a store-optional engine)

- Keep `WorkflowEngine` (store-backed) as-is for `standalone`/`control-plane`.
- Add a **distinct, store-less `WorkerRuntime`** (executes step/workflow bodies pulled from the transport; no store) and a **`ProxyRunGateway`** (read/control/start over the wire).
- The provider constructs the object(s) matching the role. Shared step execution stays in `protocol.ts`.

Rationale: isolation becomes a **structural fact** — a store-less object literally has no store field — not a runtime `if (this.store)`. Rejected the store-optional single engine because it makes isolation a runtime assertion and inflates `engine.ts`.

**Packaging:** the store-less runtime ships as a **subpath export `@adonis-agora/durable/worker`** that imports no Lucid, so a thin worker pod's dependency graph stays lean without a separate package. (Promote to a separate `@adonis-agora/durable-worker` package later only if dep weight demands it.)

## 5. Config — role-discriminated union (isolation at compile time)

`defineConfig` is a discriminated union on `role`; TypeScript narrows on the literal and forbids invalid shapes.

```ts
type DurableConfig = StandaloneConfig | ControlPlaneConfig | TenantConfig

interface StandaloneConfig {
  role: 'standalone'
  store: StoreFactory                 // required
  transport: TransportFactory         // required
  controlPlane?: ControlPlaneFactory
  namespace?: string
}

interface ControlPlaneConfig {
  role: 'control-plane'
  store: StoreFactory                 // required
  transport: TransportFactory         // required
  controlPlane?: ControlPlaneFactory
  namespace?: string
  verifyTenant?: TenantVerifier       // responder side: verifies tenant tokens (does not carry one)
}

interface TenantConfig {
  role: 'tenant'
  store?: never                       // FORBIDDEN in the type — compile-time isolation
  transport: TransportFactory         // required
  controlPlane?: ControlPlaneFactory
  partition: string                   // which tenant (required here)
  tenant?: { token?: string }         // its signed claim
  capabilities?: string[]             // extra advertised features beyond handler names
  requestTimeoutMs?: number           // ProxyRunGateway timeout
}
```

**Three-layer structural isolation:** (1) type — a `tenant` config cannot mention a store (`store?: never`); (2) container — the provider registers no store binding for the tenant role; (3) object — `WorkerRuntime`/`ProxyRunGateway` have no store field.

**Provider branch:** `durable_provider.register` reads `role` → builds `WorkflowEngine`+`StoreRunGateway`+`RunRequestResponder` (store roles; `standalone` also embeds a worker) or `ProxyRunGateway`+transport+controlPlane (tenant, no store binding). `services/main` exposes the active role's RunGateway.

## 6. Wire protocol & transport

A new driver `transports.bullmq({...})` on the real `bullmq` npm package (identical job structure the Python raw-redis runner mirrors). Pluggable — `transports.queue`/`transports.db` remain for **Adonis-only** fleets; **bullmq is required only for cross-ecosystem interop**. P4 fan-out (run-reply, tenant-events) rides the shared `ControlPlane` pub/sub, so it is transport-agnostic and the bullmq-specific surface is just the task/result queues + heartbeat registry.

### 6.1 Naming (byte-for-byte)
- prefix default `durable`; effective `P = namespace && namespace!=='default' ? ${prefix}-${namespace} : prefix`
- sanitize: only `:`→`-`, keep `.`
- group suffix: `<name>@<tenant>` when tenant set (not empty/default)
- routing token = `tenantGroup(sanitize(name), partition)`

### 6.2 Channels

| Purpose | Exact name | Mechanism |
|---|---|---|
| Task dispatch (step+workflow) | `${P}-tasks-${token}` | BullMQ queue; jobs `task`/`workflow` |
| Step result | `${P}-results` | queue; job `result` |
| Workflow decision | `${P}-decisions` | queue; job `decision` |
| Step events | `${P}-step-events` | queue; job `stepEvent` |
| Control broadcast | `${P}-control` | Redis pub/sub ✅ present |
| Run / long-step heartbeat | `${P}-heartbeat` | Redis pub/sub |
| Start-run (tenant→CP) | `${P}-start-run` | queue; job `startRun` |
| Run-request (tenant→CP) | `${P}-run-request` | queue; job `runRequest` |
| Run-reply (CP→tenant) | `${P}-run-reply` | Redis pub/sub (filter by `requestId`) |
| Tenant events (CP→tenant) | `${P}-tenant-events-${tenant}` | Redis pub/sub per tenant |
| Worker liveness/descriptor | `${P}-worker-heartbeat:${token}:${instanceId}` | Redis key `SET … EX 35` |
| Worker full descriptor | `${P}-worker-descriptor:${token}:${instanceId}` | Redis key (refreshed on change) |
| Control-plane self-advertise | `${P}-control-plane:${instanceId}` | Redis key / control message |

### 6.3 Serialization
- JSON, no envelope — the DTO **is** the job data; worker discriminates step vs workflow **by shape**.
- Dates = epoch ms (number) on cross-process DTOs; **except** dates nested in `EngineEvent`/`WorkflowRun` carried by `TenantEvent`/`RunReply` = ISO strings (`Date.toJSON`). Heartbeat `ts < 1e12` read as seconds ×1000.
- `StepError {message, code?, retryable?, stack?}` — no `name`; optionals omitted when absent.
- `StepResult` has no `name` — correlation is purely `runId`/`seq`/`stepId`.
- BullMQ priority inverted: `clamp(round(1_048_576 - priority), 1, 2_097_151)`; write opts `{removeOnComplete:true, removeOnFail:true}` (task dispatch overrides `removeOnFail:{age:86400}`).
- `instanceId` = `ts-<host>-<pid>` (Python = `py-<host>-<pid>`).

## 7. Handshake & capability negotiation

Broker-native (no direct connection): advertise-in-descriptor + validate-on-read, riding the heartbeat registry the control-plane already scans.

### 7.1 Worker Descriptor — single source of truth for routing + compat + observability
```ts
interface WorkerDescriptor {
  instanceId: string
  runtime: 'node' | 'python'
  sdk: { name: string; version: string }
  protocol: { version: number; range: [number, number] }   // wire protocol majors supported
  capabilities: string[]        // named features: 'saga','signals','search-attr-v2','priority',...
  workflows: string[]           // registered handler names → routing
  steps: string[]
  partition?: string
  namespace?: string
  startedAt: number             // epoch ms
}
```

### 7.2 Two-tier advertisement (cheap steady-state, rich on change — ETag-style)
- Heartbeat (10s, EX 35): compact `{ ts, status, descriptorHash }`.
- Full descriptor: published on startup + on change to `${P}-worker-descriptor:<token>:<instance>`. Control-plane re-reads only when `descriptorHash` changes.

### 7.3 Bilateral negotiation
The control-plane self-advertises its own descriptor (`${P}-control-plane:<instance>`). Both sides compute a **negotiated session** = highest common protocol major + capability intersection. Workers refuse tasks from an incompatible control-plane; the control-plane refuses to dispatch to incompatible workers.

### 7.4 Compatibility — three outcomes
- **Compatible** — protocol ranges intersect + required capabilities present → dispatch freely.
- **Degraded** — ranges intersect but an *optional* capability missing → dispatch, route capability-requiring work only to capable workers; soft warning.
- **Incompatible** — no range overlap → do NOT dispatch; red flag with exact reason.

### 7.5 Capability-aware routing
A workflow/step may declare `requires: ['saga','search-attr-v2']`. The control-plane dispatches only to workers whose descriptor advertises them. If no live capable worker → the run **parks as `blocked: no compatible worker (requires X)`**, visible in the dashboard — never a silent hang.

### 7.6 Loud, structured failures
`protocol.incompatible` / `capability.unavailable` diagnostics events carry both descriptors + the precise delta → telescope timeline + dashboard health panel + alertable. Never a bare boolean.

### 7.7 Backward-compat
Absence of descriptor/protocol = **legacy v1**, capabilities = the v1 baseline, assume compatible. Existing aviary workers keep flowing; rich negotiation lights up as SDKs adopt it. The current protocol is defined as **v1**; the handshake exists so a future **v2 breaking change** is detectable.

### 7.8 Cross-SDK contract fixtures
The descriptor/heartbeat/negotiation wire is captured as **golden JSON fixtures** in this spec (Appendix B). Each SDK (adonis, nestjs, python) has a conformance test producing/parsing them byte-identically — this is what keeps polyglot interop from rotting.

## 8. RunGateway & P4 semantics

Everything that calls the engine directly today (dashboard, routes, `services/main` reads) goes through a **`RunGateway`** interface. Two impls, wired by role:
- **`StoreRunGateway`** — wraps engine/store (`standalone`/`control-plane`). Direct.
- **`ProxyRunGateway`** — wire round-trip (`tenant`).

The dashboard/app code is identical regardless of store presence — the key abstraction win.

**Verbs (`RunRequestKind`, byte-compat with aviary):** `getRun`, `listRuns` (paged/filtered), `getCheckpoints/history`, `subscribe`, `signal(runId,sig,payload)`, `cancel(runId)`, `start(workflow,input,opts)`, `redispatchPending`, search-attribute reads.

**Start-run (store-less pod):** `gateway.start(...)` → `ProxyRunGateway` publishes `StartRunMessage` on `${P}-start-run`; the control-plane consumer calls `engine.start(...)` and returns the `runId` via `RunReply`.

**Read/control:** `ProxyRunGateway` mints `requestId`, publishes `RunRequest` on `${P}-run-request`, subscribes `${P}-run-reply` filtered by `requestId` (with `requestTimeoutMs`); `RunRequestResponder` answers via `StoreRunGateway` and publishes `RunReply`.

**Subscribe / live-tail:** `subscribe(runId)` bridges onto `${P}-tenant-events-<tenant>`; the control-plane republishes `EngineEvent`s for a tenant as `TenantEvent {tenant,event}` (dates ISO).

**Errors:** `RunReply {ok:false,error}` for domain errors (run not found, unauthorized tenant, unknown workflow); timeout/transport are gateway-level. Control-plane down → proxied reads fail fast with a clear error. Correlation by `requestId`; self-echo dedup by `from`.

## 9. Security — layered tenant auth

The `tenant` on a `RunRequest`/`StartRunMessage` is a **claim**; without auth the isolation boundary is meaningless. **Both layers:**
1. **Prefix/network baseline** — each tenant runs on a segmented transport prefix/namespace (+ redis/network ACL), so a pod can only reach its own prefix. (The aviary model.)
2. **Signed token on top** — each tenant pod carries a secret/token (HMAC or control-plane-issued) that signs its requests. The `RunRequestResponder` verifies the signature and **derives the tenant from it**, ignoring any `tenant` in the body. Optional-but-recommended defense in depth.

The `RunRequestResponder` is the trust boundary: forces `listRuns.namespace` = requester's tenant (no cross-tenant enumeration), validates `run.namespace === tenant` on get/signal/cancel (anti-IDOR), rejects unknown verbs, rejects invalid/tampered tokens.

## 10. Dashboard

A **health/compat panel**: per queue/group/pod — protocol version, negotiated level, red flag + reason on incompatible ("worker speaks protocol 2, control-plane speaks 1 → stopped"), and blocked runs ("requires capability X, no worker"). Fed by descriptors + diagnostics events; also surfaced in telescope.

## 11. Testing & verification

Discipline: **prove by mutation** (break it, watch the test fail) + **verify against real backends** (real Redis, real Python worker).
1. **Contract tests** — golden JSON fixtures (descriptor/heartbeat/RunRequest/RunReply/StartRunMessage/TenantEvent/task/result); Adonis produces + parses byte-identical. Same fixtures drive nestjs + python conformance (cross-repo).
2. **Real-backend interop E2E** — real Redis + the actual aviary Python worker (or a raw-redis harness mirroring `redis_runner.py`): a run started by an Adonis control-plane is executed by the Python worker and the result flows back; an Adonis worker executes a run started by a nestjs/Python control-plane.
3. **Role/isolation** — a `tenant` pod has no store binding (resolving it throws / is absent); `ProxyRunGateway`↔`StoreRunGateway` round-trip over a real transport.
4. **Tenant boundary** — a tenant cannot read/cancel another tenant's run; tampered token rejected; `listRuns` scoped.
5. **Handshake/negotiation** — incompatible major → not dispatched + blocked + diagnostics event + dashboard flag; capability-required workflow with no capable worker → parks blocked; legacy worker (no descriptor) → treated v1 compatible.

## 12. Cross-repo scope

The plan spans three repos, sharing one contract (this spec + Appendix fixtures):
- **adonis-durable** — this implementation (transport, WorkerRuntime, RunGateway/P4, handshake, config, commands, dashboard).
- **nestjs-durable** (aviary) — the descriptor/negotiation upgrade (RunGateway/P4 already exist there); adopt the same handshake + fixtures.
- **Python client** — descriptor/negotiation + conformance fixtures.

## 13. Build order (feeds writing-plans)

Dependency-ordered phases (each a plan, each green + mutation-proven before the next):
1. **BullMQ transport** (aviary wire: naming, channels, serialization, heartbeat registry) + wire-compat contract tests. → unlocks a Python worker as an execution worker against an Adonis control-plane (DTOs + control channel already match).
2. **Store-less WorkerRuntime** + `@adonis-agora/durable/worker` subpath + `durable:worker` command. → an Adonis thin worker.
3. **P4 request/reply + RunGateway** (`StoreRunGateway`/`ProxyRunGateway`/`RunRequestResponder`, start-run, tenant-events) + role-discriminated config + provider branch. → store-less api/dashboard pods.
4. **Handshake & capability negotiation** (descriptor, two-tier advertisement, negotiation, three outcomes, capability routing, loud failures) + dashboard health panel. → version-safe polyglot fleet.
5. **Layered tenant auth** (signed token verification in the responder).
6. **Cross-repo**: nestjs-durable + Python handshake + shared golden fixtures + real-backend interop E2E.

## Appendix A — wire DTOs (byte-compat with aviary)

`RunRequest {requestId, tenant, body:RunRequestKind}`; `RunReply {requestId, result: {ok:true,data} | {ok:false,error:{message,code?}}}`; `StartRunMessage {tenant, workflow, input, runId?, tags?, searchAttributes?}`; `TenantEvent {tenant, event}`; `ControlMessage = {from?} & ({kind:'event';event} | {kind:'cancel';runId} | {kind:'enqueued';runId})`; `RemoteTask`/`StepResult`/`Heartbeat {runId,seq,stepId?,group}`/`StepError`/`WorkflowTask`/`WorkflowDecision` (unchanged, already present).

## Appendix B — golden fixtures (to author during Phase 1/4)

JSON fixtures, one file per message type, checked into a shared location all three SDKs test against: `descriptor.json`, `heartbeat.json`, `run-request.json`, `run-reply.ok.json`, `run-reply.err.json`, `start-run.json`, `tenant-event.json`, `task.step.json`, `task.workflow.json`, `result.json`. Each SDK asserts it serializes to and parses from these bytes exactly.
