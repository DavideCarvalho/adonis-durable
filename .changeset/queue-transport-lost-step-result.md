---
"@adonis-agora/durable": patch
---

Fix a remote step result being silently destroyed, stalling the run forever

With `transport: 'queue'`, the results queue is point-to-point: every engine
instance on the backend polls it, so a step result can be popped by an instance
that cannot resume the run — a pod mid-rolling-deploy that does not have the
workflow registered yet, or a stale process left over from an older build.

That instance did half the job. It wrote the `completed` checkpoint (which needs
no workflow registry), then `resume()` threw `workflow … is not registered`, and
the poll loop swallowed the throw into `failJob` — removing the only copy of the
result. The run was left `suspended` with no `wakeAt`, which no recovery path can
reach: the timer poller skips it (no timer), the recovery sweep skips it (not
`running`), and a redelivered result would have been dropped as a duplicate. The
run was stuck forever, and nothing was logged. Observed in production as a
workflow whose first remote step completes and whose second step never starts,
where a manual `engine.resume(runId)` always finished the run.

Two things were wrong, and both are fixed:

- `QueueTransport`'s poll loop now REDELIVERS a job whose handler threw
  (`retryJob`, delayed one poll interval) instead of destroying it, so a result
  reaches an instance that can act on it. It also reports the error through a new
  `onError` option (default `console.error`, matching `DbTransport`) — the
  invisible failure is exactly what made this so hard to find.
- `completeRemoteResult` no longer treats an already-settled checkpoint as proof
  that the resume happened too. Settling the checkpoint and resuming the run are
  two durable effects and only the first is idempotent by its own state, so a
  redelivered result now re-drives the resume. Resuming twice is safe — the run
  lease admits one executor and replay is positional; dropping the last copy of a
  result is not.

`MockAdapter` gained the matching `retryJob` + delayed-job semantics it was
missing, so the bundled fake still mirrors what a real broker does.
