---
'@agora/durable-core': minor
'@agora/durable': minor
---

Collapse the `@agora/durable-transport-queue`, `@agora/durable-transport-db` and
`@agora/durable-store-lucid` packages into `@agora/durable-core` as config-driven drivers. Transports
and state stores are now selected by name in `config/durable.ts` via the new `transports` / `stores`
factory namespaces (`transports.memory()`, `transports.queue({ adapter, group })`, `transports.db()`,
`stores.lucid()`), each lazily importing its optional peer (`@adonisjs/queue` / `@adonisjs/lucid`)
only when selected. `defineConfig` gains `transport`/`transports` and `store`/`stores` selectors; the
provider resolves them at boot and tears the transport down on shutdown. The `node ace configure
@agora/durable` command now also publishes the Lucid migrations. The three standalone packages are
removed.
