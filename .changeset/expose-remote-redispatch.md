---
"@adonis-agora/durable": minor
---

`defineConfig` now carries `remoteRedispatchMs` / `remoteRedispatchMax` through to the engine. The engine has always implemented this store-driven net for a remote step whose dispatched job was LOST (worker crashed after claiming it, or the transport dropped the job) — but the AdonisJS provider built the engine from an explicit allowlist that omitted both keys, so the net could not be turned on from `config/durable.ts` at all, leaving `engine.redispatchPending(runId)` as the only (manual) recovery.

Off by default, unchanged semantics: when set, a reconcile pass that finds a remote step still `pending` past the window re-dispatches it, bounded by `remoteRedispatchMax` (default 10). The window must exceed the longest legitimate run of the step, and steps must be idempotent — re-dispatch can double-run a step whose original job is merely slow.
