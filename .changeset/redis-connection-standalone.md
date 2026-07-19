---
"@adonis-agora/durable": patch
---

Fix `transports.bullmq()`/`createBullMQDeps()` silently minting a Redis client bound to ioredis's own default (`127.0.0.1:6379`) instead of the caller's Redis when `connection` is falsy or an empty object — it now throws a clear, actionable error at boot instead of a silent misconnect that only surfaces as an `ECONNREFUSED 6379` retry loop once the real Redis is unreachable on the default host/port.
