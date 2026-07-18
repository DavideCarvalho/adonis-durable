"""Cross-ecosystem interop worker for the Adonis durable cluster proof.

An aviary (`durable-worker`) Python worker that owns the step ``py-echo`` and consumes it off the
SAME Redis/BullMQ queues the Adonis `BullMQTransport` dispatches to — proving the store-less cluster
wire is byte-compatible across ecosystems (Adonis control-plane -> Python execution worker).

Run:

    DURABLE_INTEROP_REDIS_URL=redis://localhost:6379 \
      .venv/bin/python py_echo_worker.py <prefix>

It registers the step ``py-echo``, so it subscribes ``<prefix>-tasks-py-echo`` and publishes the
result on ``<prefix>-results`` (the queues `packages/adonis/src/transports/bullmq/naming.ts` computes
byte-identically). The handler returns a payload tagged ``runtime="python"`` plus ``n + 1``, so the
Adonis assertion can prove the value was actually computed in Python and flowed back to resume the run.

Prints ``READY <prefix>`` on stdout once consuming, so the spawning test can wait for liveness.
"""

from __future__ import annotations

import asyncio
import os
import sys

from durable_worker import Worker
from durable_worker.redis_runner import run_redis_worker

worker = Worker(auto_register=False)


@worker.step("py-echo")
def py_echo(data):
    # `data` is whatever the Adonis workflow passed to `ctx.step('py-echo', input)`. Echo it back and
    # add a python-only marker + a computed `n + 1`, so the round-trip proves Python actually ran it.
    n = data.get("n") if isinstance(data, dict) else None
    return {
        "echoed": data,
        "runtime": "python",
        "sdk": "durable-worker",
        "nPlusOne": (n + 1) if isinstance(n, (int, float)) else None,
    }


async def main() -> None:
    prefix = sys.argv[1] if len(sys.argv) > 1 else "durable"
    connection = os.environ.get("DURABLE_INTEROP_REDIS_URL", "redis://localhost:6379")
    handle = await run_redis_worker(worker, prefix=prefix, connection=connection)
    print(f"READY {prefix}", flush=True)
    try:
        await asyncio.Event().wait()  # run until the process is killed by the test
    finally:
        await handle.close()


if __name__ == "__main__":
    asyncio.run(main())
