# @agora/durable-store-lucid

A production-grade, persistent `StateStore` for [`@agora/durable-core`](../core), backed by AdonisJS
**Lucid**. Runs, step checkpoints, durable timers, signal waiters, buffered signals, run search
attributes and recovery leases live in your SQL database — so durable workflows survive restarts and
work across processes (the core ships only an in-memory store).

It is the behavioral twin of core's `InMemoryStateStore`: identical semantics for idempotent run
creation, atomic lease acquisition/renewal, due-timer queries, FIFO pending/signal handling,
attribute upserts and status transitions — proven by driving a real `WorkflowEngine` end-to-end
against it.

## Install

```sh
npm i @agora/durable-store-lucid
```

`@adonisjs/core` and `@adonisjs/lucid` are peer dependencies (you already have them in an AdonisJS
app).

## Usage

```ts
// config/durable.ts
import db from '@adonisjs/lucid/services/db'
import { defineConfig } from '@agora/durable'
import { lucidStateStore } from '@agora/durable-store-lucid'

export default defineConfig({
  store: lucidStateStore(db),
})
```

Pass `{ connectionName }` if the durable tables live on a dedicated Lucid connection:
`lucidStateStore(db, { connectionName: 'durable' })`.

## Schema / migrations

Publish the durable-tables migration into your app, then run it:

```sh
node ace configure @agora/durable-store-lucid
node ace migration:run
```

Alternatively call the DDL helper at boot or in a script (idempotent — guarded by `hasTable`):

```ts
import { createDurableTables } from '@agora/durable-store-lucid'
await createDurableTables(db)
```

The store also implements `ensureSchema()`, which calls `createDurableTables` — wire it into your boot
if you prefer auto-provisioning.

### Tables

| Table | Purpose |
| --- | --- |
| `durable_workflow_runs` | One row per run: status, input/output/error, durable timer (`wake_at`), recovery lease (`locked_by`/`locked_until`), tags, search attributes. |
| `durable_step_checkpoints` | One row per `(run_id, seq)` step: kind, status, input/output/error, events, attempts, timing. |
| `durable_run_attributes` | Normalized search-attribute side-table (one row per `(run_id, key)`) so typed/range predicates push down into SQL via `EXISTS`. |
| `durable_signal_waiters` | The run/seq suspended on a signal `token`. |
| `durable_buffered_signals` | FIFO buffer for signals whose waiter hasn't arrived yet. |

JSON payloads (`input`/`output`/`error`/`events`/`tags`/`search_attributes`) are stored as `text` and
(de)serialized by the store. Timestamps and `wake_at` are stored as **epoch-ms integers**. This keeps
the schema portable across **SQLite / Postgres / MySQL** with no dependency on a dialect's native JSON
or date type.

## Guarantees

- **Atomic lease acquisition** — `tryLockRun` is a single conditional `UPDATE … WHERE locked_until IS
  NULL OR locked_until <= now`, so two racing engine instances can never both acquire the same run.
  `renewRunLock` only extends if the caller still owns the lease.
- **Atomic checkpoint + business write** — `transaction()` runs your DB writes and the step's "done"
  checkpoint in one Lucid transaction (powers `ctx.transaction` / exactly-once steps).
- **FIFO** — pending runs dispatch oldest-first; buffered signals are consumed in insertion order.
- **Multi-row consistency** — `createRun`/`updateRun` write the run and its attribute side-table rows
  in one transaction; `takeSignalWaiter`/`takeBufferedSignal` read-and-delete transactionally.

## SQLite vs Postgres caveats

- This adapter is dialect-portable, but the **strong cross-process durability guarantees assume a
  real concurrent database (Postgres / MySQL)**. SQLite serializes writers, so lease races can't even
  occur there; on Postgres the conditional-`UPDATE` lease is what gives you the same safety under true
  concurrency.
- A `:memory:` SQLite database is **per-connection** — pin the pool to a single connection
  (`pool: { min: 1, max: 1 }`) if you point this store at one (as the test helper does), otherwise each
  pooled connection is an independent empty database.
- Upserts are implemented as transactional read-then-write (rather than dialect-specific
  `ON CONFLICT`) precisely so the same code path is correct on every dialect.

## License

MIT
