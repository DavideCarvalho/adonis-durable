---
"@adonis-agora/durable": minor
---

Scoped automatic cross-process context restore (was a no-op on db/queue workers); recursive workflow discovery; single-extension import.

- Workers now restore the originating request's context by running each step handler INSIDE an active context store seeded from the task snapshot, via the new `Symbol.for('@agora/context:scope')` slot. The previous `@agora/context:set` path only populated an already-active store, so restore was inert on the db/queue workers (no active scope) — automatic propagation now actually works, and each task runs in its own scope (no cross-task bleed on a long-lived worker). Clean no-op when `@adonis-agora/context` is not installed.
- The dispatch carrier is passed through opaquely (`context: () => accessor.get()`) instead of merging structured `userRef`/`tenantId`/`traceId` into it — the scope slot round-trips the whole snapshot, so the producer-owned carrier stays shape-opaque.
- `app/workflows` discovery is now recursive, so nested `app/workflows/billing/charge_workflow.ts` is found (matching `make:workflow`'s nested-path scaffolding). Only the environment-appropriate module extension is imported, so a built app (`.js`) and a dev app (`.ts`) never double-register the same workflow.
