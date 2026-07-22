---
'@adonis-agora/durable': minor
---

New `@Scheduled(...)` class decorator — the decorator form of the colocated `static schedule`. It only stamps `static schedule` on the class; normalization (key defaults, `workflow` fill-in, the `static workflow` requirement) stays in `workflowSchedules`, so both authoring forms behave identically:

```ts
@Scheduled({ cron: '0 4 * * *', timezone: 'America/Sao_Paulo' })
export default class CrawlWorkflow extends BaseWorkflow {
  static workflow = { name: 'crawl' }
  async run(ctx: WorkflowCtx) { … }
}
```

Repeated applications and an existing `static schedule` literal compose, accumulating in source order (top decorator first, then the literal). With several schedules on one class, prefer explicit `key`s over the positional `${name}:${i}` defaults — the key is part of the deterministic run id, and reordering declarations would silently re-key them.
