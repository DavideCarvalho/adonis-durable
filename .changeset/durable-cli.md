---
'@adonis-agora/durable-cli': minor
---

Add `@adonis-agora/durable-cli`: AdonisJS ace commands to operate the durable workflow engine.
`durable:work` runs the long-running worker loop (pending pickup, crash recovery, due timers, and
execution-timeout sweeps) on a configurable interval with graceful SIGINT/SIGTERM shutdown and
in-flight drain. `durable:runs` lists recent runs from the configured store (filter by status and
workflow). `durable:retry <runId>` re-enqueues a run for a worker to (re-)execute. The commands
resolve the `WorkflowEngine` bound by `@adonis-agora/durable`'s provider; `node ace configure` registers the
commands barrel in `adonisrc`.
