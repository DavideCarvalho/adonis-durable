# `@agora/durable`

> Durable cross-app workflows for **AdonisJS** — deterministic replay engine.
> Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

| Package | Status | What |
|---|---|---|
| [`@agora/durable-core`](./packages/core) | ✅ shipped | framework-agnostic engine — replay, steps, signals, sleeps, child workflows, sagas/compensation, leases, DLQ, continue-as-new, cron, cancellation, versioning, plus the config-driven transport (`memory` / `queue` / `db`) and state-store (`lucid`) drivers |
| [`@agora/durable`](./packages/adonis) | ✅ shipped | AdonisJS binding — `WorkflowEngine` as a container singleton from `config/durable.ts`, transport/store drivers selected by name, best-effort `@agora/context` propagation |

Defaults to an in-process store + transport (single-process). For cross-process /
production, select a driver by name in `config/durable.ts` — the `queue`
(`@adonisjs/queue`) or `db` (`@adonisjs/lucid`) transport and the `lucid` store —
each lazily importing its optional peer only when chosen. The core is a faithful
port of `@dudousxd/nestjs-durable-core`.

## License

MIT © Davi Carvalho
