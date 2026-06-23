---
"@adonis-agora/durable": minor
---

Automatic cross-process context propagation + `app/workflows` auto-discovery and `make:workflow`.

- The full Agora request context (userRef / tenant / traceId) now rides each remote task automatically and is restored on the worker before the step handler runs — `ctx.call(remoteStep, input)` sees the originating request's context with zero manual serialize/deserialize. Best-effort, no-op when `@adonis-agora/context` is not installed.
- New class-based authoring convention mirroring `@adonisjs/queue`'s `app/jobs`: a `@Workflow` class per file under `app/workflows/` is auto-registered on the engine at boot (configurable via `workflowsPath`, opt-out with `false`), plus a `node ace make:workflow <name>` scaffold. `engine.register(name, version, fn)` remains the low-level escape hatch.
