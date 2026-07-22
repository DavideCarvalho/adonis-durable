---
'@adonis-agora/durable': minor
---

Liveness follow-ups — both halves paid for in production:

**`pickupTimeoutMs` + automatic pickup beat: queue wait is not silence.** The `timeoutMs` window is anchored at dispatch, but the stretch a job spends QUEUED produces no heartbeats by definition — a single-concurrency worker whose batches run ~15min made the next batch wait silently the whole time, and a dispatch-anchored window false-failed a healthy fleet. Now every worker emits an automatic pickup beat the moment it claims a task (via `runStepHandler` — this also stamps `lastHeartbeatAt` for handlers that never beat manually, so "queued" vs "executing" is visible on every remote checkpoint), and the new `pickupTimeoutMs` step option (def-level or per-call; defaults to `timeoutMs` — the historical behavior) governs the pre-first-beat stretch, handing over to the tighter `timeoutMs` once execution starts: `pickupTimeoutMs` = "how long may it stay queued", `timeoutMs` = "max silence while running". The heartbeat persist throttle lets a progress-carrying beat punch through when the last persisted beat had no payload, so the pickup beat never shadows the handler's first real progress.

**Singleton release no longer orphans gated runs under a no-op run dispatcher.** `wakeNext` used to CLEAR the gated run's retry `wakeAt` before handing it to the run dispatcher — but the dispatcher may legitimately be a no-op (poll-only deployments where `durable:work` owns every pickup), which left the run `suspended` with no wake time, unreachable by every poll path, forever. It now stamps a due-now `wakeAt` instead: a real dispatcher still runs it immediately, and the timer poller is the guaranteed fallback (the run lease makes a double-drive a cheap no-op).
