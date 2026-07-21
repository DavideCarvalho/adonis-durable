---
"@adonis-agora/durable": minor
---

The `queue` transport now reclaims stalled jobs. It drives the `@adonisjs/queue` adapter directly (`pushOn`/`popFrom`/`completeJob`) instead of the broker's `Worker` class — but `recoverStalledJobs` was only ever called from that same `Worker` class, so a worker that died after claiming a job left it in the broker's `active` state forever, with no re-delivery and no error (observed in production: jobs orphaned across container restarts, their steps `pending` indefinitely).

A coarse background sweep (default every 30s) now calls `adapter.recoverStalledJobs` for every queue this instance pops from — per-handler task queues on the worker side, and the results/heartbeats/control queues on the engine side (a dead engine orphans claimed result jobs the same way). New `QueueTransportOptions`: `stalledCheckIntervalMs` (default 30s; `0` disables), `stalledThresholdMs` (default 30min — the claim's `acquiredAt` is never renewed while a worker processes, so the threshold must exceed your longest legitimate step; re-delivery double-runs a merely-slow worker's step, which the durable idempotency contract makes safe but not free), `maxStalledCount` (default 3 — bounds a poison job). Adapters without `recoverStalledJobs` are detected and skipped.
