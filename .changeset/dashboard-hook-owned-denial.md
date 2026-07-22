---
'@adonis-agora/durable': patch
---

The dashboard's `authorize` hook can now own its denial response. A hook that writes a redirect before returning `false` — e.g. `ctx.response.redirect('/login')`, the natural UX when the dashboard is guarded by the host app's own session (Authkit/session + role check) instead of a bearer token — used to have its 302 overwritten by the provider's uniform `403 {"error":"forbidden"}`. The provider now respects a response the hook already wrote (detected via the `Location` header) and only falls back to the 403 when the hook left the response untouched.
