---
"@adonis-agora/durable": patch
---

Fix DashboardProvider crashing every entrypoint on boot

`DashboardProvider#boot()` resolved the router while the container was still
booting, so `router` came back `undefined` and every entrypoint — `node ace`
included — died before reaching user code. Any app that registered the
provider could not boot at all.

The router is now resolved inside `app.booted()`, once the container can
actually hand it over.

Shipped in #7 without a changeset, so the fix sat on master unreleased; this
changeset carries it to npm.
