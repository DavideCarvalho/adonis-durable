# @adonis-agora/durable

## 0.3.0

### Minor Changes

- [`6b47d1a`](https://github.com/DavideCarvalho/adonis-durable/commit/6b47d1a7d0bc6f76e5b6ebe704c3ea8cfe025d53) - Require AdonisJS v7 (bump @adonisjs/\* peers; Lucid 22, Queue 0.6)

## 0.2.0

### Minor Changes

- [`2ecedd7`](https://github.com/DavideCarvalho/adonis-durable/commit/2ecedd7984641208ba59088535ed8c165b5992b5) - Redis control-plane driver for cross-pod cancellation + lifecycle-event fan-out (multi-replica).

  Adds `controlPlanes.redis({ connection: 'main', prefix? })` and the `RedisControlPlane` class — a Redis pub/sub `ControlPlane` that broadcasts workflow lifecycle events and cancellation across every engine replica. Without it, a `cancel` issued on one pod never reaches the pod running the run and a dashboard pod can't live-tail runs executing elsewhere. The channel (`${prefix}-control`) and payload match the NestJS BullMQ transport, so an AdonisJS fleet interoperates with a NestJS fleet on the same Redis. `controlPlane` config now accepts a `ControlPlaneFactory` as well as a ready instance; `@adonisjs/redis` stays an optional, lazily-imported peer. Omit `controlPlane` and the engine remains local-only (single instance).
