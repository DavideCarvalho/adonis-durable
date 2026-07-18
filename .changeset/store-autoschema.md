---
'@adonis-agora/durable': minor
---

O provider agora **provisiona o schema do store no boot** por padrão — o durable passa a gerenciar as próprias tabelas, como o resto do ecossistema (agent/authz/telescope), em vez de exigir uma migration.

Novo `autoSchema?: boolean` no config (default `true`): quando ligado, `DurableProvider` chama `store.ensureSchema()` ao resolver o store (idempotente, `CREATE TABLE IF NOT EXISTS`; o store lucid resolve o db pelo alias `'lucid.db'`, disponível no boot). O store in-memory não tem schema, então é no-op.

```ts
// dev/prod: sem migration, a lib cria as tabelas
export default defineConfig({ store: 'lucid', stores: { lucid: stores.lucid({ connection: 'main' }) } })

// opt-out: gerencie via migration com createDurableTables(db, connection)
export default defineConfig({ autoSchema: false, store: 'lucid', stores: { lucid: stores.lucid(...) } })
```

**Mudança de comportamento:** apps existentes que criavam as tabelas via migration passam a também provisioná-las no boot (idempotente — as tabelas já existentes são um no-op). Para manter o comportamento anterior (só migration, sem DDL no boot), setar `autoSchema: false`.
