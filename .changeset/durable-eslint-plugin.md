---
'@agora/durable-eslint-plugin': minor
---

Add `@agora/durable-eslint-plugin`: ESLint rules enforcing durable-workflow determinism. The
`no-nondeterminism` rule flags `Date.now()`, `performance.now()`, `new Date()`, `Math.random()`, and
`crypto.randomUUID()` read directly in a workflow body — they differ across replays and silently
corrupt a durable run — and points to the `ctx.now()`/`ctx.random()`/`ctx.uuid()` escape hatches. It
covers both the function form (`engine.register('wf', '1', async (ctx) => …)`) and the
`@Workflow`-decorated class's `run` method, and never flags calls inside a checkpointed `ctx.step`/
`ctx.task` callback. Ships as a modern flat-config plugin with a `recommended` preset.
