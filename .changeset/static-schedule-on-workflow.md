---
"@adonis-agora/durable": minor
---

Add colocated `static schedule` on workflow classes. A `BaseWorkflow` subclass can now declare its recurring schedule(s) inline — `static schedule = { cron, timezone, paused, … }` (a single object or an array) — instead of only listing them in `config/durable.ts` → `schedules`. Colocated schedules are discovered by `app/workflows` auto-discovery and merged with the config schedules; the `durable:work` worker tick fires both identically. The default `key` is derived deterministically from the workflow name (`${name}:${i}` for an array), keeping the schedule's time-bucket run id stable. On a `key` collision, an explicit `config.schedules` entry wins. Also exports the `WorkflowScheduleConfig` type and the `workflowSchedules(cls)` reader.
