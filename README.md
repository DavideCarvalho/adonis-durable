# `@agora/durable`

> Durable cross-app workflows for **AdonisJS** — deterministic replay engine.
> Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

| Package | Status | What |
|---|---|---|
| [`@agora/durable-core`](./packages/core) | ✅ shipped | framework-agnostic engine — replay, steps, signals, sleeps, child workflows, sagas/compensation, leases, DLQ, continue-as-new, cron, cancellation, versioning (197 tests) |
| [`@agora/durable`](./packages/adonis) | ✅ shipped | AdonisJS binding — `WorkflowEngine` as a container singleton from `config/durable.ts`, best-effort `@agora/context` propagation |
| `@agora/durable-transport-queue` | 🚧 planned | `@adonisjs/queue` transport (needs result/heartbeat/control back-channels over auxiliary queues; `@adonisjs/queue` is v0.6 / early) |

Defaults to an in-process store + transport (single-process). The core is a
faithful port of `@dudousxd/nestjs-durable-core`. The default cross-process
transport for Adonis will be `@adonisjs/queue` (replacing the NestJS BullMQ
transport) once a back-channel design lands.

## License

MIT © Davi Carvalho
