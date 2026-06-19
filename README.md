# `@agora/durable`

> Durable cross-app workflows for **AdonisJS** — deterministic replay engine.
> Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

| Package | Status | What |
|---|---|---|
| [`@agora/durable-core`](./packages/core) | ✅ shipped | framework-agnostic engine — replay, steps, signals, sleeps, child workflows, sagas/compensation, leases, DLQ, continue-as-new, cron, cancellation, versioning (197 tests) |
| `@agora/durable` (Adonis binding) | 🚧 planned | provider + ace commands, wired to an `@adonisjs/queue` transport |
| `@agora/durable-transport-queue` | 🚧 planned | `@adonisjs/queue` transport (default for Adonis) |

The core is a faithful port of `@dudousxd/nestjs-durable-core` (it was already
framework-agnostic). The Adonis story replaces the NestJS BullMQ transport with
`@adonisjs/queue` as the default, per the ecosystem plan.

## License

MIT © Davi Carvalho
