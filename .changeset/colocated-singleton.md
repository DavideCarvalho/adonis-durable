---
"@adonis-agora/durable": minor
---

`static workflow` now accepts `singleton` (a `SingletonConfig`), and `app/workflows` discovery carries it through to `engine.register`. Before this, per-key run serialization was reachable only via a manual `engine.register(name, version, fn, { singleton })` — which forced anyone who needed a mutexed *scheduled* workflow to bypass the discovery convention entirely, because a colocated `static schedule` fires a new run per window whether or not the previous one is still active. Declaring `singleton: { key: () => '...' }` next to the schedule now serializes those windows natively: excess runs gate (suspended) and admit in creation order when the slot frees.
