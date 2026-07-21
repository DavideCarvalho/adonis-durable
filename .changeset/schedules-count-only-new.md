---
'@adonis-agora/durable': patch
---

`runSchedules` now fires and reports only genuinely NEW windows. It used to call the (idempotent) `engine.start` for every due window's bucket id on every tick and count the no-op — so `durable:work` logged "N scheduled" every second for the rest of each window, reading like a run-per-tick flood when nothing was being started. The pre-check costs no extra I/O (`start` did the same `getRun` internally before its no-op return); a same-boundary race between instances can still briefly overcount the report, never the runs.
