---
"@adonis-agora/durable": patch
---

Fix the Lucid store & db transport breaking `durable: true` through the app's normal boot, and honor a dedicated connection

Two boot-time bugs in the Lucid state store and db transport, both only reachable
through the real provider boot path (no prior test exercised it):

- **`stores.lucid()` / `transports.db()` resolved the Lucid `Database` from
  `@adonisjs/lucid/services/db`'s default export.** The provider builds these
  thunks while resolving the `WorkflowEngine` singleton during its OWN `boot()`,
  but `services/db` only assigns that default inside `app.booted()` — which runs
  AFTER every provider's `boot()`. So the store/transport captured `undefined`
  and threw `Cannot read properties of undefined (reading 'connection')` on the
  first run, meaning `durable: true` never actually worked through a normal app
  boot. Both now resolve the `Database` from the container (`'lucid.db'`, bound in
  the database provider's `register()`), which is available during boot and at
  runtime alike.

- **`LucidStateStore.createRun` / `updateRun` and `ensureSchema` ignored the
  configured connection.** `createRun`/`updateRun` ran their transaction on
  `this.db` (the default connection) instead of `this.client()` (the configured
  one), and `ensureSchema` provisioned tables on the default connection too — so
  on a store pinned to a dedicated connection, writes and schema landed where the
  reads never looked (`durable_workflow_runs` missing on the default connection).
  All three now go through the store's own connection. `createDurableTables` /
  `dropDurableTables` take an optional `connectionName` (backward compatible).
