# Design notes — `@agora/durable-transport-db`

## The idea: the database IS the queue (DBOS-style)

The durable [`Transport`](../core/src/interfaces.ts) contract is bidirectional:

- `dispatch(task)` — engine → worker (a `RemoteTask`).
- `onResult(handler)` — worker → engine (a `StepResult`).
- `onHeartbeat(handler)` — worker → engine (liveness for a long step).
- `ControlPlane` (`publishControl` / `onControl`) — a **broadcast** across every engine instance.

Instead of a broker (Redis/SQS/BullMQ), each channel is a **table** in the same Lucid database the
durable store already uses. Remote steps are rows: `dispatch` inserts a task row; a worker poller
claims it, runs the handler via the shared `runStepHandler`, and inserts a result row the engine
polls. Zero new infrastructure — often the simplest production transport.

| Channel | Table | Producer | Consumer |
| --- | --- | --- | --- |
| Step dispatch | `durable_transport_tasks` | engine (`dispatch`) | worker task loop (`handle`) |
| Step results | `durable_transport_results` | worker | engine loop (`onResult`) |
| Heartbeats | `durable_transport_heartbeats` | worker (`heartbeat`) | engine loop (`onHeartbeat`) |
| Control | `durable_transport_control` | any (`publishControl`) | any loop (`onControl`) |

Each row is a one-shot message: claimed by exactly one consumer, handled, then deleted. JSON payloads
are TEXT and all timestamps are epoch-ms `bigInteger`, so the schema is portable across SQLite /
Postgres / MySQL with no native JSON/date dependency.

## Atomic claiming — portable, no `FOR UPDATE SKIP LOCKED`

The natural DBOS approach is `SELECT … FOR UPDATE SKIP LOCKED`, but that excludes SQLite (and the
in-memory SQLite we test against). Instead we use a **portable compare-and-set**, the same pattern as
the Lucid store's recovery lease (`tryLockRun`):

1. Select up to `batchSize` candidate ids that are unclaimed **or** whose lease expired
   (`claimed_at IS NULL OR claimed_at < now − leaseMs`), oldest first.
2. A conditional `UPDATE … SET claimed_by = <round-token>, claimed_at = <now>` over those ids,
   **re-checking the same un-leased predicate**. Two instances racing the same rows can't both stamp
   them — the loser's UPDATE matches nothing for the contended rows.
3. `SELECT` back exactly the rows carrying this round's unique token, run them, delete them.

The `claimed_by` token is unique per claim round (`instanceId:hrtime`), so the select-back is exact
even when one instance claims several rounds quickly. A crashed worker's claim is reclaimed once its
lease expires — the engine dedupes any resulting re-delivery by `stepId`, so at-least-once is safe.

## Honest limitations

### Control plane is single-consumer, not broadcast

`onControl` is the one place the contract wants **fan-out** (every pod must see a `cancel` /
lifecycle `event`). A claim-and-delete row is point-to-point: each control row is handled by exactly
one poller. So:

- For a **single engine instance**, `ControlPlane` works correctly.
- For **multiple instances**, a control message reaches only one of them — a cancel issued on pod A
  may be consumed by pod B's loop without reaching the pod actually running the run.

A correct multi-instance control plane needs real pub/sub (the BullMQ transport uses Redis
`PUBLISH`/`SUBSCRIBE`). A polled table cannot fan out without per-instance cursors and retention,
which we deliberately do not build. Multi-instance deployments should pass a dedicated pub/sub
`controlPlane` to the engine alongside this transport; the table control plane is provided for the
single-instance case and is documented as such.

### Polling latency & at-least-once

No push delivery, so each consumer polls on `pollIntervalMs` (default 200ms; lower it for snappier
steps at the cost of more queries). Delivery is at-least-once: a crash between handling a row and
deleting it re-delivers — fine for the durable engine, which dedupes by `stepId`.

### Not implemented (optional `Transport` methods)

`dispatchWorkflowTask` / `onDecision` / `dispatchStepEvent` / `onStepEvent` (polyglot workflows),
`groupHealth`, and `listWorkerGroups` are intentionally omitted — they need broker introspection
(queue depth, a worker-heartbeat keyspace, pub/sub) beyond a polled table. They are optional in the
contract and the engine degrades gracefully when a transport doesn't implement them.
