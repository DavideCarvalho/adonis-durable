---
'@adonis-agora/durable': minor
---

Step-level liveness, end to end: `log.heartbeat(progress?)` for long step handlers.

A long remote step (a 15-minute browser batch) was indistinguishable from a hung one: logs and sub-events only ship WITH the result, the heartbeat lane existed in every transport but nothing could emit into it, and the in-memory `timeoutMs` path persisted no checkpoint at all mid-flight — so status surfaces had to infer liveness from domain tables.

Now the step handler's `StepLogger` carries `heartbeat(progress?)`: it travels immediately over the transport's heartbeat lane (throttled, ≥5s between emissions), rearms the step's `timeoutMs` window on the engine (a beating step never falsely times out — so `timeoutMs` can be tightened to "max tolerated silence" instead of "max total duration"), and the engine persists the latest beat on the step's checkpoint (throttled ≥10s, best-effort) as `StepCheckpoint.lastHeartbeatAt` / `heartbeatProgress` — visible cross-process via `listCheckpoints`, and in `durable:runs` (the PENDING column shows `hb <age>`; `--stale` no longer flags a step whose worker beat within the threshold).

The in-memory `timeoutMs` path now also persists its `pending` checkpoint at dispatch (per attempt): the step becomes visible outside its process, beats have somewhere to land, and a result consumed by a different engine instance completes the checkpoint instead of being dropped. Replay semantics are unchanged (`timeoutMs` steps route to the in-memory path regardless of an existing pending row; `completed` still short-circuits).

New optional store capability: `StateStore.recordStepHeartbeat(runId, seq, at, progress?)` (implemented by the Lucid and in-memory stores; the checkpoints table gains nullable `last_heartbeat_at`/`heartbeat_progress`, auto-migrated in place by `ensureSchema`).
