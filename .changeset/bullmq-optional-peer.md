---
"@adonis-agora/durable": patch
---

Make `bullmq` an optional peer dependency instead of a hard dependency.

0.15 added `bullmq` as a hard `dependency`. Because `bullmq` pins an EXACT `ioredis`
(e.g. `ioredis@5.11.1`), every app installing durable got a SECOND ioredis copy in its tree —
including apps that only use `transports.queue()`/`db`/`eventEmitter` and never touch the bullmq
transport. With two ioredis copies present, `@boringnode/queue`'s `redis()` adapter factory checks
`connection instanceof Redis` against its own ioredis copy; the live connection `@adonisjs/redis`
handed it was built by the OTHER copy, so the check is false, the factory falls through to
`new Redis({ host: 'localhost', port: 6379 })`, and the app hangs at boot in an
`ECONNREFUSED 127.0.0.1:6379` retry loop instead of reusing the configured Redis.

`bullmq` is now an optional peer dependency, loaded lazily (via a non-literal specifier) only inside
`createBullMQDeps`, the code path behind `transports.bullmq()`. Apps that do not select the bullmq
transport no longer install bullmq, no longer gain the duplicate ioredis, and no longer hit the
`instanceof` mismatch. Apps that DO use `transports.bullmq()` should add `bullmq` to their own
dependencies (the optional peer makes this explicit).
