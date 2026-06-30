---
"@adonis-agora/durable": minor
---

feat: worker-pool namespaces for shared-store multi-pool deploys

The engine now propagates its namespace to the transport pool: the `queue` transport folds a non-`'default'` namespace into its queue prefix (`durable-<namespace>:…`) and the in-process `eventEmitter`/in-memory transports segment their channels, so multiple pools can share one broker/bus without cross-processing tasks (`'default'` stays byte-identical). `RunQuery.namespace` filters run searches when provided.
