---
"@adonis-agora/durable": minor
---

Redesign the step surface around a single, always-dispatched `ctx.step` (BREAKING).

`ctx.step` is now the ONE durable step primitive — always dispatched to a worker, routed BY HANDLER NAME:

- `ctx.step(refOrName, input, opts?)` replaces the old `ctx.call(remoteStepDef, input, opts)`. Pass a `@Step`/`defineStep` handler reference (typed, refactor-safe) or a plain string name (cross-runtime, zero-decorator baseline). It always dispatches and the run suspends until the result lands.
- The old in-process `ctx.step(name, fn, options)` is renamed to `ctx.localStep(name, fn, options)` (body unchanged; keeps `compensate`).
- `ctx.random()` and `ctx.uuid()` are REMOVED. Use `ctx.sideEffect(fn)` — a general deterministic-capture primitive: `ctx.sideEffect(() => crypto.randomUUID())`, `() => Math.random()`, a config read. `ctx.now()` is unchanged.
- `remoteStep()`, `RemoteStepDef`, and `RemoteStepConfig.group` are REMOVED. The dispatched carrier is now `StepDef { name, partition?, input?, output? }` with input/output OPTIONAL zod schemas (validated at the serve boundary, skipped when absent).
- Step routing is BY NAME everywhere: the dispatch token and every worker subscribe/queue site derive `tenantGroup(sanitizeQueueToken(name), partition)`. `QueueTransport`/`DbTransport` now subscribe one queue PER handler name; their `group` option is deprecated (accepted, ignored) — use the new optional `partition`.

New authoring layer:

- `@Step(nameOrOptions?)` method decorator + `defineStep(name, fn, config?)` helper, stamping the routing name (and optional zod schemas + per-def retry/backoff/timeout policy) via the global `DURABLE_STEP_NAME`/`DURABLE_STEP_CONFIG` symbols.
- `app/steps` auto-discovery (`config.stepsPath`, `@adonis-agora/durable/hooks/steps` barrel) registers discovered `@Step`/`defineStep` handlers on the transport by name — zero manual `transport.handle(...)`.
- `ctx.step`'s 3rd arg (`StepDispatchOpts`) carries per-call `retries`/`backoff`/`backoffMs`/`backoffMaxMs`/`jitter`/`timeoutMs` (overriding the `@Step`-declared policy field-by-field) plus a dispatched saga `compensate` (a `@Step`/name undo run with the `StepUndo` envelope on failure/compensating-cancel).

Operator namespace subset (additive): `StartOptions.namespace` (per-run partition override, inherited by `retryWithInput`), `EngineEvent.namespace` on `run.*` lifecycle events, and an opt-in `remoteByConvention` engine dep that routes an unregistered workflow to a live worker group of the same name.

The eslint rule `no-nondeterminism` now suggests `ctx.sideEffect(...)` (instead of `ctx.random()`/`ctx.uuid()`) and treats `ctx.localStep`/`ctx.task`/`ctx.sideEffect` (not `ctx.step`) as the checkpoint-callback boundaries.
