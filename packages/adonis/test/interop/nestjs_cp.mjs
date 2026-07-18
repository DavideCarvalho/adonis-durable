/**
 * Reverse cross-ecosystem interop CONTROL-PLANE for the store-less cluster proof.
 *
 * A standalone aviary (`nestjs-durable`) `WorkflowEngine` + BullMQ transport pointed at a live Redis.
 * It registers a workflow whose body dispatches a durable `ctx.step('adonis-echo', …)` — a step NAME
 * a store-less **Adonis** `WorkerRuntime` owns and executes off the SAME Redis/BullMQ queues. This
 * closes the loop on the forward proof (Adonis control-plane -> Python worker): here an aviary
 * control-plane dispatches on the shared wire and an Adonis worker executes it, returning a
 * byte-compatible result that resumes the aviary run to `completed`.
 *
 * Boots the engine by DIRECTLY constructing it (mirroring nestjs-durable's own
 * `packages/transport-bullmq/src/bullmq-transport.db.spec.ts`), NOT a full Nest app. The two aviary
 * packages are imported by ABSOLUTE path from the nestjs-durable checkout's built `dist/` so this
 * script can live in the Adonis repo yet run against the real aviary engine (their internal bare
 * imports — `bullmq`, `ioredis`, the core package — resolve from within the nestjs packages).
 *
 * Usage (invoked by `adonis-worker.interop.spec.ts`; args/env it passes):
 *   DURABLE_INTEROP_REDIS_URL=redis://host:port \
 *   DURABLE_INTEROP_NESTJS=/abs/path/to/nestjs-durable \
 *     node nestjs_cp.mjs <prefix> <runId>
 *
 * Protocol with the spawning spec (stdout, line-oriented):
 *   READY                 — engine constructed + workflow registered, about to start the run.
 *   RESULT <json>         — terminal (or blocked) outcome: `{ status, output, error }`. Then exits 0.
 *   FATAL <message>       — an unexpected boot/dispatch error. Exits 1.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.argv[2] ?? 'durable';
const runId = process.argv[3] ?? 'reverse-interop-run-1';
const redisUrl = process.env.DURABLE_INTEROP_REDIS_URL ?? 'redis://localhost:6379';
const nestjsDir = process.env.DURABLE_INTEROP_NESTJS;

if (!nestjsDir) {
  console.log('FATAL DURABLE_INTEROP_NESTJS not set');
  process.exit(1);
}

const importFrom = (rel) => import(pathToFileURL(join(nestjsDir, rel)).href);

async function main() {
  const { WorkflowEngine, InMemoryStateStore } = await importFrom('packages/core/dist/index.js');
  const { BullMQTransport } = await importFrom('packages/transport-bullmq/dist/index.js');

  // ioredis takes `host`/`port` (not a `url` key) — parse the URL into the shape the transport's
  // Queue/Worker connection accepts, exactly as the forward Adonis spec does.
  const parsed = new URL(redisUrl);
  const connection = { host: parsed.hostname, port: Number(parsed.port || 6379) };

  const transport = new BullMQTransport({ connection, prefix });
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport });

  // The workflow owns a single durable step named `adonis-echo` — a step NAME the Adonis worker owns.
  // The engine dispatches it onto `${prefix}-tasks-adonis-echo`; the Adonis worker executes it and
  // publishes the StepResult on `${prefix}-results`, which resumes this run.
  engine.register('reverse-interop', '1', async (ctx) => {
    const out = await ctx.step('adonis-echo', { n: 41 });
    return out;
  });

  console.log('READY');

  await engine.start('reverse-interop', {}, runId);

  // Poll the store until the aviary run reaches a terminal (or visibly-blocked) status — the same
  // shape as the aviary db spec's `settle()`.
  const deadline = Date.now() + 30_000;
  let run;
  for (;;) {
    run = await store.getRun(runId);
    const s = run?.status;
    if (s && s !== 'pending' && s !== 'running' && s !== 'suspended') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `RESULT ${JSON.stringify({
      status: run?.status ?? 'timeout',
      output: run?.output ?? null,
      error: run?.error ?? null,
    })}`,
  );

  await transport.close();
  process.exit(0);
}

main().catch((err) => {
  console.log(`FATAL ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
