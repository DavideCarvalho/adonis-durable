# @agora/durable-dashboard

A self-contained web dashboard and JSON API for inspecting and operating
[`@agora/durable`](../adonis) workflow runs inside an AdonisJS app.

- **JSON API** over the `WorkflowEngine` + its store: list/inspect runs, view the
  step timeline, retry/cancel runs, and read worker-group health.
- **One self-contained HTML page** (inline CSS + vanilla JS, no build step) that
  consumes the API — a clean, dark-friendly dev tool.
- **Configurable auth guard** so the dashboard is safe to mount in production.

## Install

```sh
npm i @agora/durable-dashboard
node ace configure @agora/durable-dashboard
```

`configure` registers the provider and publishes `config/durable_dashboard.ts`.
It requires `@agora/durable` to already be configured (the dashboard reads runs
from the same `StateStore` you set in `config/durable.ts`, so that store must be
set — the engine keeps its own store private).

## Configuration — `config/durable_dashboard.ts`

```ts
import { defineConfig } from '@agora/durable-dashboard'

export default defineConfig({
  enabled: true,          // master switch; false registers no routes
  path: '/durable',       // mount prefix (HTML at the root, API under <path>/api)
  authorize: (ctx) => ctx.auth.user?.isAdmin === true,
})
```

The default `authorize` allows everything **outside** production, and **in
production** requires a bearer token equal to the `DURABLE_DASHBOARD_TOKEN`
environment variable (deny if unset — fail-closed). Supply the token via an
`Authorization: Bearer …` header, an `x-durable-token` header, or a `?token=`
query param.

## Routes

Relative to the configured `path` (default `/durable`):

| Method | Path                     | Description                                  |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/`                      | The dashboard HTML                           |
| GET    | `/api/runs`              | List runs (`status`, `workflow`, `tag`, paged) |
| GET    | `/api/runs/:id`          | Run detail: run + step timeline + child ids  |
| POST   | `/api/runs/:id/retry`    | Re-enqueue the run (replays checkpoints)      |
| POST   | `/api/runs/:id/cancel`   | Cancel the run (`{ compensate: true }` to undo a saga) |
| GET    | `/api/health`            | Per-group worker health (backlog + workers)  |

The JSON handlers are framework-light pure functions (`@agora/durable-dashboard`
exports `listRuns`, `getRun`, `retryRun`, `cancelRun`, `health`), so you can test
or reuse them without an HTTP server.
