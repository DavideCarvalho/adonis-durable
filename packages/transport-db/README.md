# `@agora/durable-transport-db`

A poll-based, **DB-table-backed** [`Transport`](https://www.npmjs.com/package/@agora/durable-core)
for [`@agora/durable-core`](https://www.npmjs.com/package/@agora/durable-core), over AdonisJS
[**Lucid**](https://lucid.adonisjs.com). Durable remote steps (`ctx.call(...)`) run cross-process
using only your database — no Redis, no queue broker, no extra infrastructure. The database you
already have IS the queue (DBOS-style). This is often the simplest production transport.

```sh
npm i @agora/durable-transport-db @adonisjs/lucid
```

## Usage

Publish the transport tables and wire it into `config/durable.ts`:

```sh
node ace configure @agora/durable-transport-db
node ace migration:run
```

```ts
import db from '@adonisjs/lucid/services/db'
import { defineConfig } from '@agora/durable'
import { createDbTransport } from '@agora/durable-transport-db'

export default defineConfig({
  // engine side: dispatches tasks, consumes results/heartbeats
  transport: createDbTransport({ db }),
})
```

A **worker process** registers handlers for its group; the task poll loop starts automatically:

```ts
import db from '@adonisjs/lucid/services/db'
import { createDbTransport } from '@agora/durable-transport-db'

const transport = createDbTransport({ db, group: 'pipeline' })
transport.handle('payments.charge-card', async (input, log) => {
  log.debug('charging', input)
  return await chargeCard(input)
})
```

Run `transport.close()` (or `stop()`) on shutdown to stop the poll loops; the shared `Database` is
left open (the app owns it). The wire payloads are the documented `RemoteTask` / `StepResult` JSON.

### Standalone (no AdonisJS app)

Without an app, create the tables with the DDL helper:

```ts
import { createDbTransport, createDurableTransportTables } from '@agora/durable-transport-db'

await createDurableTransportTables(db) // idempotent DDL (SQLite / Postgres / MySQL)
const transport = createDbTransport({ db })
```

## How it works

Each `Transport` channel is a table; rows are one-shot messages — claimed by exactly one consumer,
handled, then deleted:

| Channel | Table | Direction |
| --- | --- | --- |
| Step dispatch | `durable_transport_tasks` | engine → worker |
| Step results | `durable_transport_results` | worker → engine |
| Heartbeats | `durable_transport_heartbeats` | worker → engine |
| Control | `durable_transport_control` | best-effort (see below) |

A worker poller atomically **claims** unclaimed task rows with a portable compare-and-set
(`UPDATE … SET claimed_by` re-checking the un-leased predicate — no `FOR UPDATE SKIP LOCKED`, so it
works on SQLite too), runs the handler via core's `runStepHandler`, and inserts a result row the
engine polls. A crashed worker's claim is reclaimed once its lease (`leaseMs`) expires; the engine
dedupes any re-delivery by `stepId`.

### Options

`pollIntervalMs` (default 200), `leaseMs` (default 30s), `batchSize` (default 20), `group`,
`connectionName`, `autoCreate` (default true), `instanceId`.

## Limitations

Read [`DESIGN.md`](./DESIGN.md) for the full rationale. In short:

- **`ControlPlane` is single-consumer.** A claim-and-delete row is point-to-point: each control
  message is handled by exactly one poller, so cancellation / live-tail are correct for a **single
  engine instance** but do **not** fan out to every pod the way a real pub/sub control plane (e.g.
  the BullMQ transport's Redis pub/sub) does. For multi-instance broadcast, pair the engine with a
  dedicated pub/sub `controlPlane`.
- **Delivery is at-least-once with polling latency** bounded by `pollIntervalMs`.
- **Throughput is bounded by polling + row contention** — great for workflow/pipeline scale (modest
  rate, long steps), not for high-fanout firehoses.
- **Polyglot workflow tasks, `groupHealth`, and worker-group discovery are not implemented** — those
  optional `Transport` methods need broker introspection beyond a polled table.

Dispatch, atomic claiming, worker-handler execution, and the result/heartbeat round-trip are fully
implemented and tested against real SQL (in-memory SQLite — no external services in the test suite),
including a full `WorkflowEngine` end-to-end run.

## License

MIT © Davi Carvalho
