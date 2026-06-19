# `@agora/durable-core`

Durable workflow engine for AdonisJS — deterministic replay, steps, signals,
sleeps, child workflows, compensation/sagas, leases, DLQ, continue-as-new,
cron schedules, cancellation, and versioning. Framework-agnostic core of the
Agora durable ecosystem.

```ts
import { WorkflowEngine } from '@agora/durable-core'
```

Bring your own transport + state store. An in-memory transport + state store ship
for tests; an `@adonisjs/queue` transport and persistent stores are the Adonis
binding (planned).

## License

MIT © Davi Carvalho
