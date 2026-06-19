# Design notes — `@agora/durable-transport-queue`

## The contract vs. the tool

The durable [`Transport`](../core/src/interfaces.ts) contract is inherently **bidirectional**:

- `dispatch(task)` — engine → worker (a `RemoteTask`).
- `onResult(handler)` — worker → engine (a `StepResult`).
- `onHeartbeat(handler)` — worker → engine (liveness for a long step).
- `ControlPlane` (`publishControl` / `onControl`) — a **broadcast** across every engine instance.

`@adonisjs/queue` v0.6 (powered by `@boringnode/queue` v0.5) is, by contrast, a **one-directional**
job queue. Its public model is:

1. Define a `Job` class (`extends Job<Payload>`) with an `execute()` method.
2. `MyJob.dispatch(payload).toQueue(q).run()` to enqueue.
3. A separate `Worker` process (`new Worker(config).start([queues])`) polls queues, instantiates the
   job, and runs `execute()`.

There is **no mechanism for the dispatcher to await a job's result** — `execute()` returns `void`,
and the worker is a different process. So the durable engine's "result flows back to the caller"
requirement cannot be satisfied by `dispatch` + `Worker` alone.

## What we build on instead: the adapter

Both `@adonisjs/queue` and `@boringnode/queue` expose the lower-level **`Adapter`** interface
(`AdapterFactory`) that the high-level `Job`/`Worker` machinery sits on. It is a plain queue store:

- `pushOn(queue, jobData)` — enqueue.
- `popFrom(queue)` — atomically move the next job from pending → active (returns `null` if empty).
- `completeJob(id, queue)` / `failJob(id, queue, err)` — settle an acquired job.
- `setWorkerId(id)`, `destroy()`.

Built-in adapters: `redis`, `knex` (Postgres/SQLite), and `FakeAdapter` for tests.

By driving the adapter directly we get **full control of both directions**, modelling each channel as
its own point-to-point queue and running our own poll loops:

| Channel | Queue | Producer | Consumer |
| --- | --- | --- | --- |
| Step dispatch | `<prefix>:tasks:<group>` | engine (`dispatch`) | worker poll loop (`handle`) |
| Step results | `<prefix>:results` | worker | engine poll loop (`onResult`) |
| Heartbeats | `<prefix>:heartbeats` | worker (`heartbeat`) | engine poll loop (`onHeartbeat`) |
| Control | `<prefix>:control` | any (`publishControl`) | any poll loop (`onControl`) |

The worker side funnels every task through the shared `runStepHandler(task, handler)` from
`@agora/durable-core`, so the completed / failed / no-handler contract (and the `startedAt` stamp) is
identical to every other transport and language port. All payloads cross as the documented
`RemoteTask` / `StepResult` JSON.

## Honest limitations

### Control plane is single-consumer, not broadcast

`onControl` is the one place the contract wants **fan-out** (every pod must see a `cancel` or a
lifecycle `event`). A pop-based queue is point-to-point: `popFrom` hands each message to exactly one
consumer. So:

- For a **single engine instance**, `ControlPlane` works correctly.
- For **multiple instances**, a control message reaches only one of them — cancellation issued on pod
  A may be consumed by pod B's loop without reaching the pod actually running the run.

A correct multi-instance control plane needs real pub/sub (the BullMQ transport uses Redis
`PUBLISH`/`SUBSCRIBE`). `@adonisjs/queue` does not expose pub/sub, so we cannot implement true
broadcast here. We implement the point-to-point version (useful for single-instance and for the
`enqueued` nudge) and document the constraint; multi-instance deployments should pass a dedicated
pub/sub `controlPlane` to the engine alongside this transport.

### Polling latency & at-least-once

There is no push delivery, so each consumer polls on `pollIntervalMs` (default 200ms). Delivery is
at-least-once: a crash between `onJob` succeeding and `completeJob` would re-deliver — fine for the
durable engine, which dedupes step results by `stepId`.

### Not implemented (optional `Transport` methods)

`dispatchWorkflowTask` / `onDecision` / `dispatchStepEvent` / `onStepEvent` (polyglot workflows),
`groupHealth`, and `listWorkerGroups` are intentionally omitted — they need broker introspection
(queue depth, a worker-heartbeat keyspace, pub/sub) that v0.6 does not surface. They are optional in
the contract, and the engine degrades gracefully when a transport doesn't implement them.

## Why not the `Job`/`Worker` API at all?

We could have wrapped the high-level API: define a `DurableStepJob` whose `execute()` runs the
handler and then `dispatch`es a `DurableResultJob`, and run a `Worker` per side. But that adds the
`Locator`/glob job-registration and `QueueManager` singleton lifecycle for no behavioural gain — the
adapter path is simpler, fully under our control, and trivially testable with a tiny in-memory mock
adapter (no Redis in the test suite). If a future `@adonisjs/queue` adds in-process result
consumption or pub/sub, this transport can adopt it behind the same public surface.
