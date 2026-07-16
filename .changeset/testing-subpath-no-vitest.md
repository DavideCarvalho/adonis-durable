---
"@adonis-agora/durable": minor
---

Fix: `@adonis-agora/durable/testing` is now importable without `vitest` installed

`vitest` has always been an *optional* peer dependency — the intent is that any
app can use the test harness (`createTestEngine`, asserts, fault injection,
deterministic replay) with whatever test runner it likes (Japa, node:test,
etc.), and only pay for `vitest` when it opts into the conformance suites.

In practice that promise was broken: `/testing` is a single barrel, and two of
its modules (`runAdmissionBackendContract`, `runStateStoreContract`) import
`vitest` unconditionally to generate their `describe`/`it` suites. Because a
barrel re-exports everything from every file it aggregates, importing
`anything` from `/testing` — even just `createTestEngine` — pulled in both
conformance generators and therefore required `vitest` to be resolvable, full
stop. A real app on Japa hit exactly this: `Cannot find package 'vitest'`,
forcing it to hand-roll the harness the library already ships.

**Fix.** The two conformance generators move out of the `/testing` barrel into
a new dedicated subpath, `@adonis-agora/durable/testing/conformance`. `/testing`
itself no longer imports `vitest` anywhere in its module graph — verified by a
regression test that statically walks the import graph rather than merely
`import()`-ing it (which would pass vacuously inside this repo's own
vitest-powered test suite regardless of the bug). `assertTransportConformance`
stays in `/testing`: it's a plain async function with no `describe`/`it`, so it
never needed `vitest` in the first place.

**Breaking change** for anyone importing `runAdmissionBackendContract` or
`runStateStoreContract` from `@adonis-agora/durable/testing` — switch that
import to `@adonis-agora/durable/testing/conformance`. Every such consumer
necessarily already has `vitest` installed (nothing from `/testing` was
importable otherwise before this fix), so the only change needed is the
import path.
