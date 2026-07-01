---
"@adonis-agora/durable": patch
---

DbTransport now honors worker-pool namespaces. Previously the `db` transport
ignored namespaces entirely: two engines on different namespaces sharing one
transport table set would cross-claim each other's tasks/results/heartbeats/
control and could stall runs (a result claimed by the wrong engine wrote a
`completed` checkpoint before throwing `NamespaceMismatch`). Every transport
row now carries a `namespace` column and every claim is scoped to it, matching
the queue/event-emitter transports. `"default"` (and absent) is byte-compatible
with the pre-namespace scheme; pre-existing transport tables are auto-upgraded
(the `namespace` column is back-filled to `'default'`).
