---
'@agora/durable-store-lucid': minor
---

Add `@agora/durable-store-lucid`: a persistent, Lucid-backed `StateStore` for the durable workflow
engine. Runs, step checkpoints, durable timers, signal waiters, buffered signals, run search
attributes and recovery leases live in SQL (SQLite / Postgres / MySQL), so durable workflows survive
restarts and work across processes. Ships a `createDurableTables` DDL helper, an Adonis migration
published by `node ace configure`, and the `lucidStateStore(db)` factory for `config/durable.ts`.
