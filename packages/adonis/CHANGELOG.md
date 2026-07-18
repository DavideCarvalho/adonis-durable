# @adonis-agora/durable

## 0.13.0

### Minor Changes

- Convention dispatch is now **on by default** — a run started for a workflow this engine has no local registration for is routed to a live worker group of the same name, with **no `registerRemote` boilerplate**. This matches the aviary engine (which has always routed by convention) and is what makes a Python/NestJS/thin-worker workflow reachable by name: just `engine.start('pipeline', input)` (or `ctx.child('pipeline', …)`) and a live `pipeline` worker group picks it up.

  Opt out with `remoteByConvention: false` in `config/durable.ts` to restore the fail-fast "workflow is not registered" throw for unknown names. `registerRemote(...)` still exists for pinning a specific group/version, but is no longer required.

## 0.12.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/adonis-durable/pull/15) [`ae3fbee`](https://github.com/DavideCarvalho/adonis-durable/commit/ae3fbee7e00a32ff9d2463d616aeea8a1a5ac566) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O provider agora **provisiona o schema do store no boot** por padrão — o durable passa a gerenciar as próprias tabelas, como o resto do ecossistema (agent/authz/telescope), em vez de exigir uma migration.

  Novo `autoSchema?: boolean` no config (default `true`): quando ligado, `DurableProvider` chama `store.ensureSchema()` ao resolver o store (idempotente, `CREATE TABLE IF NOT EXISTS`; o store lucid resolve o db pelo alias `'lucid.db'`, disponível no boot). O store in-memory não tem schema, então é no-op.

  ```ts
  // dev/prod: sem migration, a lib cria as tabelas
  export default defineConfig({ store: 'lucid', stores: { lucid: stores.lucid({ connection: 'main' }) } })

  // opt-out: gerencie via migration com createDurableTables(db, connection)
  export default defineConfig({ autoSchema: false, store: 'lucid', stores: { lucid: stores.lucid(...) } })
  ```

  **Mudança de comportamento:** apps existentes que criavam as tabelas via migration passam a também provisioná-las no boot (idempotente — as tabelas já existentes são um no-op). Para manter o comportamento anterior (só migration, sem DDL no boot), setar `autoSchema: false`.

## 0.11.0

### Minor Changes

- Store-less cluster + cross-ecosystem interop: separate API from engine and run store-less "thin" pods that only talk to the control plane. New role-discriminated config (`standalone` / `control-plane` / `tenant`, `store?: never` on tenant → compile-time isolation), an aviary byte-compatible BullMQ transport (a Python aviary worker can share the same control plane, proven live both directions), the P4 RunGateway (Store/Proxy/Responder) request/reply protocol with layered tenant auth, a store-less WorkerRuntime running steps + workflow turns + parallel `gather` (subpath `@adonis-agora/durable/worker`, no Lucid), a worker-descriptor handshake with capability/protocol negotiation + capability-aware dispatch (park `blocked` instead of hanging), and a dashboard fleet-health panel. Adds `bullmq` as a dependency.

## 0.10.0

### Minor Changes

- Parity sync from nestjs-durable: retry now re-executes failed runs (was a no-op), self-heal event-waiting suspends orphaned by a lost wake (`reconcileMs`), recover a remote step whose dispatched job was lost (`redispatchPending` + `remoteRedispatchMs`), cascade retry + retry-adoption, and `ctx.all` failFast cancels surviving siblings + `webhook().wait({ timeoutMs })`.

## 0.9.1

### Patch Changes

- [#13](https://github.com/DavideCarvalho/adonis-durable/pull/13) [`b43fdc8`](https://github.com/DavideCarvalho/adonis-durable/commit/b43fdc8a5824bfc71920d8ccb55f0a765614bc0a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the Lucid store & db transport breaking `durable: true` through the app's normal boot, and honor a dedicated connection

  Two boot-time bugs in the Lucid state store and db transport, both only reachable
  through the real provider boot path (no prior test exercised it):

  - **`stores.lucid()` / `transports.db()` resolved the Lucid `Database` from
    `@adonisjs/lucid/services/db`'s default export.** The provider builds these
    thunks while resolving the `WorkflowEngine` singleton during its OWN `boot()`,
    but `services/db` only assigns that default inside `app.booted()` — which runs
    AFTER every provider's `boot()`. So the store/transport captured `undefined`
    and threw `Cannot read properties of undefined (reading 'connection')` on the
    first run, meaning `durable: true` never actually worked through a normal app
    boot. Both now resolve the `Database` from the container (`'lucid.db'`, bound in
    the database provider's `register()`), which is available during boot and at
    runtime alike.

  - **`LucidStateStore.createRun` / `updateRun` and `ensureSchema` ignored the
    configured connection.** `createRun`/`updateRun` ran their transaction on
    `this.db` (the default connection) instead of `this.client()` (the configured
    one), and `ensureSchema` provisioned tables on the default connection too — so
    on a store pinned to a dedicated connection, writes and schema landed where the
    reads never looked (`durable_workflow_runs` missing on the default connection).
    All three now go through the store's own connection. `createDurableTables` /
    `dropDurableTables` take an optional `connectionName` (backward compatible).

## 0.9.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/adonis-durable/pull/10) [`6b60f1e`](https://github.com/DavideCarvalho/adonis-durable/commit/6b60f1e844891128edc02adca1edc109a831a26a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix: `@adonis-agora/durable/testing` is now importable without `vitest` installed

  `vitest` has always been an _optional_ peer dependency — the intent is that any
  app can use the test harness (`createTestEngine`, asserts, fault injection,
  deterministic replay) with whatever test runner it likes (Japa, node:test,
  etc.), and only pay for `vitest` when it opts into the conformance suites.

  In practice that promise was broken: `/testing` is a single barrel, and two of
  its modules (`runAdmissionBackendContract`, `runStateStoreContract`) import
  `vitest` unconditionally to generate their `describe`/`it` suites. Because a
  barrel re-exports everything from every file it aggregates, importing
  `anything` from `/testing` — even just `createTestEngine` — pulled in both
  conformance generators and therefore required `vitest` to be resolvable, full
  stop. A real app on Japa hit exactly this: `Cannot find package 'vitest'`,
  forcing it to hand-roll the harness the library already ships.

  **Fix.** The two conformance generators move out of the `/testing` barrel into
  a new dedicated subpath, `@adonis-agora/durable/testing/conformance`. `/testing`
  itself no longer imports `vitest` anywhere in its module graph — verified by a
  regression test that statically walks the import graph rather than merely
  `import()`-ing it (which would pass vacuously inside this repo's own
  vitest-powered test suite regardless of the bug). `assertTransportConformance`
  stays in `/testing`: it's a plain async function with no `describe`/`it`, so it
  never needed `vitest` in the first place.

  **Breaking change** for anyone importing `runAdmissionBackendContract` or
  `runStateStoreContract` from `@adonis-agora/durable/testing` — switch that
  import to `@adonis-agora/durable/testing/conformance`. Every such consumer
  necessarily already has `vitest` installed (nothing from `/testing` was
  importable otherwise before this fix), so the only change needed is the
  import path.

### Patch Changes

- [#11](https://github.com/DavideCarvalho/adonis-durable/pull/11) [`bc0111c`](https://github.com/DavideCarvalho/adonis-durable/commit/bc0111c2dcb49ac397850d32a1e12c5a02c122a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix a remote step result being silently destroyed, stalling the run forever

  With `transport: 'queue'`, the results queue is point-to-point: every engine
  instance on the backend polls it, so a step result can be popped by an instance
  that cannot resume the run — a pod mid-rolling-deploy that does not have the
  workflow registered yet, or a stale process left over from an older build.

  That instance did half the job. It wrote the `completed` checkpoint (which needs
  no workflow registry), then `resume()` threw `workflow … is not registered`, and
  the poll loop swallowed the throw into `failJob` — removing the only copy of the
  result. The run was left `suspended` with no `wakeAt`, which no recovery path can
  reach: the timer poller skips it (no timer), the recovery sweep skips it (not
  `running`), and a redelivered result would have been dropped as a duplicate. The
  run was stuck forever, and nothing was logged. Observed in production as a
  workflow whose first remote step completes and whose second step never starts,
  where a manual `engine.resume(runId)` always finished the run.

  Two things were wrong, and both are fixed:

  - `QueueTransport`'s poll loop now REDELIVERS a job whose handler threw
    (`retryJob`, delayed one poll interval) instead of destroying it, so a result
    reaches an instance that can act on it. It also reports the error through a new
    `onError` option (default `console.error`, matching `DbTransport`) — the
    invisible failure is exactly what made this so hard to find.
  - `completeRemoteResult` no longer treats an already-settled checkpoint as proof
    that the resume happened too. Settling the checkpoint and resuming the run are
    two durable effects and only the first is idempotent by its own state, so a
    redelivered result now re-drives the resume. Resuming twice is safe — the run
    lease admits one executor and replay is positional; dropping the last copy of a
    result is not.

  `MockAdapter` gained the matching `retryJob` + delayed-job semantics it was
  missing, so the bundled fake still mirrors what a real broker does.

## 0.8.1

### Patch Changes

- [#8](https://github.com/DavideCarvalho/adonis-durable/pull/8) [`9e3d803`](https://github.com/DavideCarvalho/adonis-durable/commit/9e3d803258986ffe27f9136bce5200f0d6bbdf00) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix DashboardProvider crashing every entrypoint on boot

  `DashboardProvider#boot()` resolved the router while the container was still
  booting, so `router` came back `undefined` and every entrypoint — `node ace`
  included — died before reaching user code. Any app that registered the
  provider could not boot at all.

  The router is now resolved inside `app.booted()`, once the container can
  actually hand it over.

  Shipped in [#7](https://github.com/DavideCarvalho/adonis-durable/issues/7) without a changeset, so the fix sat on master unreleased; this
  changeset carries it to npm.

## 0.8.0

### Minor Changes

- [`86819e0`](https://github.com/DavideCarvalho/adonis-durable/commit/86819e08666a307046e8845a7d9b9ed3685d7c53) - BaseWorkflow is the sole authoring form; `services/main`; dashboard login; signal/child/subscriber fixes

  **BREAKING — the `@Workflow` decorator is removed.** Author workflows with a
  `BaseWorkflow` subclass plus `static workflow = { name, version }`:

  ```ts
  // before
  @Workflow({ name: "charge", version: "1" })
  class ChargeWorkflow {
    async run(ctx: WorkflowCtx, input: Input) {}
  }

  // after
  export default class ChargeWorkflow extends BaseWorkflow {
    static workflow = { name: "charge", version: "1" };
    async run(ctx: WorkflowCtx, input: Input) {}
  }
  ```

  `workflowMeta()` now reads only the `static workflow` config; normalization is
  unchanged (version defaults to `'1'`). One authoring form means one thing to
  document, one thing to discover, and no decorator/metadata runtime.

  **Features**

  - `BaseWorkflow` with context-aware static `start`/`dispatch`. Call
    `ChargeWorkflow.start(input)` and it does the right thing by context: outside a
    workflow it enqueues on the engine and blocks until the run reaches a terminal
    state; inside one it starts a linked child and suspends the parent. `.dispatch`
    is the fire-and-forget twin, returning `{ runId }` without waiting.
  - `@adonis-agora/durable/services/main` — an idiomatic singleton import, so app
    code reaches the engine the way it reaches any other Adonis service.
  - Control-flow signal marker plus `isWorkflowControlFlowSignal`, so a workflow
    can tell a control-flow signal apart from a domain one.
  - Buffered events are now reliable: an event delivered before its waiter exists is
    no longer lost.
  - Dashboard built-in login screen via `dashboardAuth`.

  **Fixes**

  - Closed a lost-wake race in the signal waiter, and added the
    `removeSignalWaiter` SPI so a waiter can be torn down deterministically.
  - A child that fails to _start_ now surfaces the failure to the parent instead of
    stranding it. The parent used to wait forever on a child that never existed:
    the start was fire-and-forget, so nothing ever notified the parent. The child
    start is now deferred and its rejection is reported to the parent as a failed
    child result.
  - The Redis control plane now heals a silently-dead subscriber connection. A
    subscriber whose socket died without an error event stopped delivering messages
    while still looking healthy, and every wake-up routed through it was lost. A
    ping watchdog now detects the dead connection and forces a reconnect.
  - `BaseWorkflow.start` waits for terminal (matching the linked-child path), the
    steps hook is configurable, and the dashboard token comparison is
    constant-time.

  **eslint-plugin** — `no-nondeterminism` identifies a workflow's `run` body by the
  new authoring form (a `BaseWorkflow` subclass, or any class with a
  `static workflow` config) instead of the removed `@Workflow` decorator. Without
  this the rule would silently stop guarding every workflow in a 0.8 codebase.

## 0.6.1

### Patch Changes

- [`ef0a9da`](https://github.com/DavideCarvalho/adonis-durable/commit/ef0a9dab56eb492bb8daef4c06d56685ff42060d) - DbTransport now honors worker-pool namespaces. Previously the `db` transport
  ignored namespaces entirely: two engines on different namespaces sharing one
  transport table set would cross-claim each other's tasks/results/heartbeats/
  control and could stall runs (a result claimed by the wrong engine wrote a
  `completed` checkpoint before throwing `NamespaceMismatch`). Every transport
  row now carries a `namespace` column and every claim is scoped to it, matching
  the queue/event-emitter transports. `"default"` (and absent) is byte-compatible
  with the pre-namespace scheme; pre-existing transport tables are auto-upgraded
  (the `namespace` column is back-filled to `'default'`).

## 0.5.0

### Minor Changes

- [`9ae80aa`](https://github.com/DavideCarvalho/adonis-durable/commit/9ae80aa167fc27157b8e7c605bdb2805e6730dea) - feat: in-process EventEmitter transport; workflows codegen via Adonis assembler hook

  - New production **in-process** transport `transports.eventEmitter()` backed by a single Node `EventEmitter`: a single-process app runs real durable workflows with NO external infrastructure (no DB, no Redis, no broker). It decouples dispatch → worker → result over the event loop (mirroring a real broker), and funnels every step through `runStepHandler`, so the scoped context restore works identically. Distinct from the test-only `transports.memory()`. Selectable via `transport: 'event-emitter'` in `config/durable.ts`; the default is unchanged.
  - Workflows discovery now prefers a **build-time barrel** generated by an AdonisJS Assembler `init` hook (`@adonis-agora/durable/hooks/workflows`), exactly how core generates the controllers/events/listeners barrels via `IndexGenerator`. The dev server / test runner / bundler generates `.adonisjs/durable/workflows.ts` and the file watcher regenerates it on change; the provider imports it at boot instead of scanning `app/workflows` with `readdir`. Register it in `adonisrc.ts` under `hooks.init` (the `configure` command wires it for you). The runtime `readdir` scan is kept as a **fallback** so apps that don't register the hook keep working unchanged.

## 0.4.0

### Minor Changes

- [`d2591d0`](https://github.com/DavideCarvalho/adonis-durable/commit/d2591d0040bafb2301b41250e91a5d2961d9ad13) - Automatic cross-process context propagation + `app/workflows` auto-discovery and `make:workflow`.

  - The full Agora request context (userRef / tenant / traceId) now rides each remote task automatically and is restored on the worker before the step handler runs — `ctx.call(remoteStep, input)` sees the originating request's context with zero manual serialize/deserialize. Best-effort, no-op when `@adonis-agora/context` is not installed.
  - New class-based authoring convention mirroring `@adonisjs/queue`'s `app/jobs`: a `@Workflow` class per file under `app/workflows/` is auto-registered on the engine at boot (configurable via `workflowsPath`, opt-out with `false`), plus a `node ace make:workflow <name>` scaffold. `engine.register(name, version, fn)` remains the low-level escape hatch.

- [`6c31452`](https://github.com/DavideCarvalho/adonis-durable/commit/6c31452f14789fa98f20ea5f6164f421d76fc2df) - Scoped automatic cross-process context restore (was a no-op on db/queue workers); recursive workflow discovery; single-extension import.

  - Workers now restore the originating request's context by running each step handler INSIDE an active context store seeded from the task snapshot, via the new `Symbol.for('@agora/context:scope')` slot. The previous `@agora/context:set` path only populated an already-active store, so restore was inert on the db/queue workers (no active scope) — automatic propagation now actually works, and each task runs in its own scope (no cross-task bleed on a long-lived worker). Clean no-op when `@adonis-agora/context` is not installed.
  - The dispatch carrier is passed through opaquely (`context: () => accessor.get()`) instead of merging structured `userRef`/`tenantId`/`traceId` into it — the scope slot round-trips the whole snapshot, so the producer-owned carrier stays shape-opaque.
  - `app/workflows` discovery is now recursive, so nested `app/workflows/billing/charge_workflow.ts` is found (matching `make:workflow`'s nested-path scaffolding). Only the environment-appropriate module extension is imported, so a built app (`.js`) and a dev app (`.ts`) never double-register the same workflow.

## 0.3.0

### Minor Changes

- [`6b47d1a`](https://github.com/DavideCarvalho/adonis-durable/commit/6b47d1a7d0bc6f76e5b6ebe704c3ea8cfe025d53) - Require AdonisJS v7 (bump @adonisjs/\* peers; Lucid 22, Queue 0.6)

## 0.2.0

### Minor Changes

- [`2ecedd7`](https://github.com/DavideCarvalho/adonis-durable/commit/2ecedd7984641208ba59088535ed8c165b5992b5) - Redis control-plane driver for cross-pod cancellation + lifecycle-event fan-out (multi-replica).

  Adds `controlPlanes.redis({ connection: 'main', prefix? })` and the `RedisControlPlane` class — a Redis pub/sub `ControlPlane` that broadcasts workflow lifecycle events and cancellation across every engine replica. Without it, a `cancel` issued on one pod never reaches the pod running the run and a dashboard pod can't live-tail runs executing elsewhere. The channel (`${prefix}-control`) and payload match the NestJS BullMQ transport, so an AdonisJS fleet interoperates with a NestJS fleet on the same Redis. `controlPlane` config now accepts a `ControlPlaneFactory` as well as a ready instance; `@adonisjs/redis` stays an optional, lazily-imported peer. Omit `controlPlane` and the engine remains local-only (single instance).
