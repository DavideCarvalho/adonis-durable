---
'@agora/durable-transport-db': minor
---

Add `@agora/durable-transport-db`: a poll-based, DB-table-backed `Transport` (and best-effort
single-instance `ControlPlane`) for the durable workflow engine, over AdonisJS Lucid. Durable remote
steps run cross-process using only the database — no Redis or queue broker. `dispatch` inserts a task
row; a worker poller atomically claims it (portable compare-and-set, no `FOR UPDATE SKIP LOCKED`, so
SQLite/Postgres/MySQL all work), runs the handler, and writes a result row the engine polls.
Heartbeats and control ride their own tables. Ships the `createDbTransport(db, opts?)` factory, a
`createDurableTransportTables` DDL helper, and an Adonis migration published by `node ace configure`.
