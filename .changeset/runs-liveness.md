---
"@adonis-agora/durable": minor
---

`durable:runs` now surfaces liveness signals so a `suspended` run's listing stops looking identical whether it's mid-step or stranded. `suspended` is the run's normal resting state while a remote step is in flight — it's also the only symptom a lost dispatch (worker died after claiming the job) ever produces, and nothing auto-redrives it (see `redispatchPending`'s own doc).

Each row now shows RECOVERY (`recovery_attempts`, blank unless > 0) and PENDING (the age + attempt count of the oldest `pending` REMOTE checkpoint, for `running`/`suspended` runs) alongside the existing columns; UPDATED now renders as a compact duration (`4h32m`) instead of `"4h ago"`.

A new `--stale[=<duration>]` flag (default threshold 15m, e.g. `--stale=1h`) narrows the listing to runs whose pending remote step exceeds that age — the "these are probably stranded" view — and prints a hint pointing at the two recovery paths that actually exist: `engine.redispatchPending(runId)` and `node ace durable:retry <runId>`.

The dashboard's `GET /runs` list payload also gains `recoveryAttempts` per run (free — already on the row); the oldest-pending-checkpoint age was deliberately left off that endpoint to avoid an N+1 `listCheckpoints` per row — `GET /runs/:id` already returns the full checkpoint timeline for that.

New exports from `@adonis-agora/durable/*` command surface: `attachLiveness`, `filterStale`, `parseDurationMs`, `staleHint`, `DEFAULT_STALE_MS`, `RunLiveness`, `StalePendingStep`. `RunLister` now also requires `listCheckpoints` (both `WorkflowEngine` and every `StateStore` already implement it) and `renderRunsTable` now takes `RunLiveness[]` instead of `WorkflowRun[]`.
