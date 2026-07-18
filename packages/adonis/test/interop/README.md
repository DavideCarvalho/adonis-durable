# Cross-ecosystem interop proof (Adonis control-plane → Python worker)

The crown-jewel proof that the store-less cluster wire is **byte-compatible across ecosystems**: an
Adonis `WorkflowEngine` (control-plane) dispatches a durable `ctx.step('py-echo', …)` onto the aviary
BullMQ/Redis wire, a **real aviary (`nestjs-durable`) Python worker** consumes it off
`${P}-tasks-py-echo`, executes it, and publishes the result on `${P}-results` — which resumes the
Adonis run to `completed` with the value Python computed.

Files:

- `py_echo_worker.py` — an aviary `durable-worker` worker that owns the step `py-echo`.
- `python-worker.interop.spec.ts` — the Adonis-side engine + assertions. **Gated**, so it SKIPS
  cleanly in CI (no Redis / Python / `bullmq` needed).

## Gating env vars

| Var | Required | Meaning |
| --- | --- | --- |
| `DURABLE_INTEROP_REDIS_URL` | yes | Live Redis URL. The whole suite skips without it. |
| `DURABLE_INTEROP_PYTHON` | optional | Path to a Python interpreter with `durable-worker[redis]` installed. When set, the spec **spawns** the worker itself. When unset, it assumes a worker is already consuming `py-echo` on the same prefix and just waits for it. |

## Run it (proven green)

From `packages/adonis`, with **Node 22** and a live Redis. Requires `bullmq` installed in
`node_modules` (declared in `package.json`; `npm install` / `pnpm install` provides it).

### 1. Ephemeral Redis (Docker)

```bash
PORT=6399
docker run -d -p ${PORT}:6379 --name durable-interop-redis redis:7-alpine
```

### 2. Python worker deps (once)

```bash
cd ../../.. # to the nestjs-durable checkout, or wherever clients/python lives
python3 -m venv clients/python/.venv
clients/python/.venv/bin/pip install -e 'clients/python[redis]'
```

### 3. Run the spec (it spawns the worker)

```bash
cd packages/adonis   # of the adonis-durable checkout
DURABLE_INTEROP_REDIS_URL=redis://localhost:6399 \
DURABLE_INTEROP_PYTHON=/abs/path/to/clients/python/.venv/bin/python \
  node_modules/.bin/vitest run test/interop
```

### 4. Tear down

```bash
docker rm -f durable-interop-redis
```

## What it asserts (live wire evidence)

1. The Python worker's handshake descriptor (`${P}-worker-descriptor:py-echo:*`) is SCANned + JSON
   round-tripped by the **Adonis** transport — `runtime: "python"`, `steps: ["py-echo"]`.
2. The Adonis run reaches `completed` with `{ echoed: { n: 41 }, runtime: "python",
   sdk: "durable-worker", nPlusOne: 42 }` — the value **computed in Python**.
3. The remote checkpoint is routed to the `py-echo` token.
4. Both `bull:${P}-tasks-py-echo:*` (Adonis → Python) and `bull:${P}-results:*` (Python → Adonis)
   keys exist under one shared `bull:` keyspace — the byte-level shared wire.

The `console.log` at the end prints the descriptor, the Python-computed output, and the shared Redis
keys, so a live run documents its own evidence.
