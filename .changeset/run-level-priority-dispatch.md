---
'@adonis-agora/durable': minor
---

Re-add run-level priority dispatch (parity with the NestJS engine). `StartOptions.priority` is now
stamped on the `WorkflowRun` and persisted by the Lucid store (new nullable `priority` column,
auto-migrated for existing tables). The run's priority rides every `WorkflowTask` the remote workflow
executor dispatches, and per-call `ctx.call(..., { priority })` rides the `RemoteTask`. `ctx.child` /
`ctx.startChild` accept a `{ priority }` option (or a bare string `childId` as before) that stamps the
child run. The queue transport translates the engine's "higher wins" priority onto the
`@adonisjs/queue` job priority ("lower wins") via `toBrokerPriority`, so an urgent task can jump ahead
of already-enqueued lower-priority ones. Priority is best-effort ordering, not correctness state — a
transport without priority support ignores it.

Internal DI/container token symbols are renamed from the leftover `nestjs-durable:` namespace to
`@agora/durable:` (`STATE_STORE`, `TRANSPORT`, `DURABLE_OPTIONS`, and the `@Workflow` name key). The
cross-library `@agora/diagnostics:emit` global slot is unchanged.
