# `@agora/durable-transport-queue`

A [`@adonisjs/queue`](https://www.npmjs.com/package/@adonisjs/queue)-backed
[`Transport`](https://www.npmjs.com/package/@agora/durable-core) for
[`@agora/durable-core`](https://www.npmjs.com/package/@agora/durable-core). It dispatches durable
remote steps (`ctx.call(...)`) to queue workers and carries their results back, so steps can run in
a separate process — or a separate machine — over Redis or a SQL-backed queue.

```sh
npm i @agora/durable-transport-queue @adonisjs/queue
```

## Usage

Wire it into `config/durable.ts` with any `@adonisjs/queue` adapter:

```ts
import { defineConfig } from '@agora/durable'
import { createQueueTransport } from '@agora/durable-transport-queue'
import { redis } from '@adonisjs/queue'

export default defineConfig({
  transport: createQueueTransport({
    adapter: redis({ host: '127.0.0.1', port: 6379 }),
    group: 'pipeline', // the worker group this process serves; omit on an engine-only process
  }),
})
```

The **engine side** dispatches tasks and consumes results (`onResult` / `onHeartbeat`). A **worker
process** registers handlers and runs them:

```ts
import { createQueueTransport } from '@agora/durable-transport-queue'
import { redis } from '@adonisjs/queue'

const transport = createQueueTransport({ adapter: redis(), group: 'pipeline' })
transport.handle('payments.charge-card', async (input, log) => {
  log.debug('charging', input)
  return await chargeCard(input)
})
```

The wire payloads are the documented `RemoteTask` / `StepResult` JSON, so non-Node workers on the
same queues interoperate. Call `transport.close()` on shutdown to stop the poll loops and release the
adapter.

## How it works

`@adonisjs/queue` v0.6 is a **one-directional** job queue (dispatch → a separate `Worker` process
runs `job.execute()`), with no built-in way to await a job's result. To give the durable engine the
back-channels it needs (results + heartbeats flowing back, control broadcast), this transport drives
the underlying queue **adapter** directly — `pushOn` to enqueue, a polling `popFrom` loop to consume,
`completeJob` / `failJob` to settle. Both directions are therefore plain point-to-point queues we
fully control:

| Channel | Queue | Direction |
| --- | --- | --- |
| Step dispatch | `<prefix>:tasks:<group>` | engine → worker |
| Step results | `<prefix>:results` | worker → engine |
| Heartbeats | `<prefix>:heartbeats` | worker → engine |
| Control | `<prefix>:control` | best-effort (see below) |

## Limitations

This is built on `@adonisjs/queue` **v0.6** (early). Read [`DESIGN.md`](./DESIGN.md) for the full
rationale, but in short:

- **`ControlPlane` is single-consumer.** A pop-based queue is point-to-point: each control message is
  delivered to exactly one consumer, so cancellation / live-tail are correct for a **single engine
  instance** but do **not** fan out to every pod the way a real pub/sub control plane (e.g. the
  BullMQ transport's Redis pub/sub) does. For multi-instance broadcast, pair the engine with a
  dedicated pub/sub `controlPlane`.
- **Delivery is at-least-once with polling latency.** Consumers poll on an interval
  (`pollIntervalMs`, default 200ms); there is no push notification, so result/heartbeat delivery is
  bounded by that interval.
- **Polyglot workflow tasks, `groupHealth`, and worker-group discovery are not implemented** — those
  optional `Transport` methods need broker introspection that v0.6 doesn't expose.

The dispatch + JSON serialization + worker-handler-execution + result/heartbeat round-trip are fully
implemented and tested (no Redis required in the test suite).

## License

MIT © Davi Carvalho
