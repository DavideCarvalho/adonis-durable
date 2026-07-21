---
'@adonis-agora/durable': minor
---

Console/REPL processes no longer become accidental queue workers.

Every booted app process used to subscribe the transport's consumer loops (step tasks, results, heartbeats, control): the engine's constructor binds results/heartbeats and the provider serves `app/steps` at boot. On a point-to-point broker transport that made ANY `node ace` process compete with the real worker fleet — a one-off command claimed step jobs it died with (observed in production as jobs wedged in `active` stamped with the worker ids of long-gone commands), stole results addressed to the long-lived engine, and a boot-time command with jobs queued never exited (the burst-drain loop kept feeding it, blocking a container's `exec durable:work` handoff forever).

Now, with the new config default `consumers: 'auto'`, a `console`/`repl` process **defers** consumption: it can still dispatch runs, publish and read the store — a pure producer — while jobs stay queued for a real worker. `durable:work` declares itself a worker via the new `engine.startConsumers()` before its first tick, so the worker command behaves identically. Web and test processes keep today's eager behavior, and `consumers: 'always'` restores it everywhere (for a console script that must round-trip remote steps inline).

New surface: optional `Transport.deferConsumers()` / `Transport.startConsumers()` (implemented by `QueueTransport`; in-process transports need no gating), `TransportPool.startConsumers()`, `WorkflowEngine.startConsumers()`, and `consumers?: 'auto' | 'always'` on the config.
