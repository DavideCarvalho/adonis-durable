# `@agora/durable`

> Durable cross-app workflows for **AdonisJS** — deterministic replay engine.
> Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

Everything ships in **one** package — install `@agora/durable` and reach each
feature through a subpath. The deterministic replay engine + AdonisJS binding is
the default entry; the integrations are optional subpaths whose peer dependencies
are installed only when used.

| Package | Status | What |
|---|---|---|
| [`@agora/durable`](./packages/adonis) | ✅ shipped | the whole library — engine + AdonisJS binding (`.`), plus subpaths: `./otel`, `./telescope`, `./dashboard` (+ `./dashboard_provider`), `./commands` (ace commands), `./testing`, `./admission-redis` |
| [`@agora/durable-eslint-plugin`](./packages/eslint-plugin) | ✅ shipped | ESLint rules enforcing workflow determinism (resolved by name; kept standalone) |

### Subpaths

| Import | What |
|---|---|
| `@agora/durable` | framework-agnostic engine (replay, steps, signals, sleeps, child workflows, sagas/compensation, leases, DLQ, continue-as-new, cron, cancellation, versioning), the config-driven transport (`memory` / `queue` / `db`) and state-store (`lucid`) drivers, and the AdonisJS binding (`defineConfig`, `WorkflowEngine` as a container singleton from `config/durable.ts`) |
| `@agora/durable/otel` | OpenTelemetry spans + lightweight metrics — one trace per run, one span per step (needs `@opentelemetry/api`) |
| `@agora/durable/telescope` | a `@agora/telescope` extension — a Workflows health dashboard (golden signals) |
| `@agora/durable/dashboard` | a self-contained web dashboard + JSON API for inspecting/operating runs (wire `@agora/durable/dashboard_provider`) |
| `@agora/durable/commands` | the ace commands — `durable:work`, `durable:runs`, `durable:retry` |
| `@agora/durable/testing` | test harness + cross-backend conformance suites (needs `vitest`) |
| `@agora/durable/admission-redis` | Redis-backed global admission backend for fleet-wide concurrency/rate/priority/fairness (needs `@adonisjs/redis` + `ioredis`) |

Defaults to an in-process store + transport (single-process). For cross-process /
production, select a driver by name in `config/durable.ts` — the `queue`
(`@adonisjs/queue`) or `db` (`@adonisjs/lucid`) transport and the `lucid` store —
each lazily importing its optional peer only when chosen. The engine is a faithful
port of `@dudousxd/nestjs-durable-core`.

## License

MIT © Davi Carvalho
