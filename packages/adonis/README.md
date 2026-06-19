# `@agora/durable`

AdonisJS binding for [`@agora/durable-core`](https://www.npmjs.com/package/@agora/durable-core)
— a container-resolved durable workflow engine.

```sh
npm i @agora/durable
node ace configure @agora/durable
```

```ts
import { WorkflowEngine } from '@agora/durable'

const engine = await app.container.make(WorkflowEngine)
engine.register('order', '1', async (ctx) => {
  const charge = await ctx.step('charge', () => chargeCard(ctx.input))
  await ctx.step('ship', () => ship(charge))
})
await engine.start('order', input, runId)
```

Defaults to an in-process store + transport (single-process, zero infra). Supply a
persistent store and a broker-backed transport in `config/durable.ts` for
production. When `@agora/context` is installed, the originating tenant/user/
correlation carrier rides each dispatched task (best-effort, no hard dependency).

## License

MIT © Davi Carvalho
