---
'@adonis-agora/durable': patch
---

A result arriving after its run went terminal no longer resurrects the run.

`completeRemoteResult` guarded only `cancelled`/`completed`: a late result for a **failed**/**dead** run settled the checkpoint and resumed it — observed in production as a `failed` run flipping to `suspended` and carrying on as if the failure never happened, racing whatever the operator had done about it (and, had the workflow used sagas, running AFTER compensations already unwound). Terminal is terminal: recovery of a failed run belongs to an explicit `requeue`/`durable:retry`, never to a stray result.

Semantics now: for a failed/dead run, a late **success** still settles the checkpoint (salvage — an explicit retry's replay short-circuits the finished step instead of re-running minutes of real work) but never resumes; a late **failure** is dropped outright; the redelivered-result re-drive path (settled checkpoint → resume) also refuses terminal runs. Cancelled/completed behavior is unchanged.
