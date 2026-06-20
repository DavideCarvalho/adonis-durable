---
'@agora/durable-dashboard': minor
---

Add `@agora/durable-dashboard`: a web dashboard + JSON API for inspecting and operating durable
workflow runs in an AdonisJS app. A provider mounts routes under a configurable prefix (default
`/durable`) behind a pluggable `authorize(ctx)` guard from `config/durable_dashboard.ts` — open
outside production, bearer-token-gated (`DURABLE_DASHBOARD_TOKEN`) and fail-closed in production by
default. The JSON API (`GET /api/runs` filtered + paged, `GET /api/runs/:id` with step timeline and
children, `POST /api/runs/:id/retry`, `POST /api/runs/:id/cancel`, `GET /api/health`) is built from
framework-light, exported, unit-testable handlers over the `WorkflowEngine` and its store. The root
path serves a single self-contained HTML page (inline CSS + vanilla JS, no build) that lists runs
with status badges and filters and shows a per-run step timeline with retry/cancel actions; the API
base path is injected at serve time. `node ace configure` registers the provider and publishes the
config.
