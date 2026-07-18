import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { RedisWorkerRegistry, WorkerRuntime } from '../../src/worker-runtime/index.js';

/**
 * CROWN-JEWEL cross-ecosystem interop proof — the REVERSE direction (store-less cluster design §11).
 *
 * The forward proof (`python-worker.interop.spec.ts`) showed an Adonis control-plane dispatching a step
 * a REAL aviary (`nestjs-durable`) Python worker executes. This closes the loop: an aviary
 * `WorkflowEngine` (control-plane) dispatches a durable `ctx.step('adonis-echo', …)` onto the aviary
 * BullMQ wire, a **store-less Adonis `WorkerRuntime`** consumes it off `${P}-tasks-adonis-echo`,
 * executes the body, and publishes the `StepResult` on `${P}-results` — which resumes the AVIARY run to
 * `completed` with the value the ADONIS worker computed. This proves the wire is byte-compatible in
 * BOTH directions over a real Redis: aviary control-plane -> Adonis execution worker.
 *
 * The aviary engine is booted by a standalone Node control-plane script (`nestjs_cp.mjs`) run against
 * the nestjs-durable checkout's built `dist/` (constructed DIRECTLY, mirroring nestjs-durable's own
 * `bullmq-transport.db.spec.ts` — not a full Nest app). The Adonis worker ADVERTISES its handshake
 * descriptor to the shared Redis, so the aviary control-plane's dispatch-negotiation guard
 * (handshake design §7.5) sees a protocol-compatible worker and routes to it (rather than parking the
 * run `blocked`) — exercising the cross-SDK descriptor read too.
 *
 * GATED (skips cleanly in CI — no Redis / nestjs-durable checkout / bullmq needed):
 *   - `DURABLE_INTEROP_REDIS_URL` — the live Redis (required).
 *   - `DURABLE_INTEROP_NESTJS`    — abs path to a built nestjs-durable checkout (required; the aviary
 *                                   control-plane script imports its built `packages/.../dist`). Build
 *                                   the transport first: cd packages/transport-bullmq && tsup.
 *
 * Run (from packages/adonis, with a live Redis + a built nestjs-durable checkout):
 *   DURABLE_INTEROP_REDIS_URL=redis://localhost:6399 \
 *   DURABLE_INTEROP_NESTJS=/abs/path/to/nestjs-durable \
 *     node_modules/.bin/vitest run test/interop/adonis-worker.interop.spec.ts
 */
const REDIS_URL = process.env.DURABLE_INTEROP_REDIS_URL;
const NESTJS_DIR = process.env.DURABLE_INTEROP_NESTJS;
const RUN = !!(REDIS_URL && NESTJS_DIR);

const HERE = dirname(fileURLToPath(import.meta.url));
const CP_SCRIPT = resolve(HERE, 'nestjs_cp.mjs');

const closers: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of closers) await Promise.resolve(c()).catch(() => {});
});

/** Poll `fn` until it returns truthy or the deadline passes; throws with `label` on timeout. */
async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** SCAN every key matching `pattern` (cursor loop), via a raw ioredis client. */
async function scanKeys(
  raw: { scan: (...a: unknown[]) => Promise<[string, string[]]> },
  pattern: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await raw.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

describe.skipIf(!RUN)('aviary control-plane -> Adonis worker interop (real Redis)', () => {
  it('executes a step the aviary control-plane dispatched and resumes the aviary run to completed', async () => {
    const prefix = `durable-reverse-interop-${Date.now()}`;
    const runId = 'reverse-interop-run-1';
    const parsed = new URL(REDIS_URL as string);
    const connection = { host: parsed.hostname, port: Number(parsed.port || 6379) } as unknown;

    const require = createRequire(import.meta.url);
    const { Redis } = require('ioredis') as { Redis: new (url: string) => any };

    // --- Adonis side: a store-less WorkerRuntime over the aviary BullMQ transport --------------
    const transport = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'adonis-worker',
    });
    closers.push(() => transport.close());

    // A dedicated ioredis client for the handshake registry (advertises the descriptor + heartbeat so
    // the aviary control-plane's dispatch guard sees a live, protocol-compatible worker).
    const registryRedis = new Redis(REDIS_URL as string);
    const registry = new RedisWorkerRegistry(registryRedis, { ownsConnection: true });

    const runtime = new WorkerRuntime({
      transport,
      // `default` partition keeps the routing token BARE (`adonis-echo`) — byte-identical to the token
      // the aviary engine dispatches to (which uses no tenant).
      partition: 'default',
      prefix,
      instanceId: 'adonis-worker',
      registry,
    });
    closers.push(() => runtime.stop());

    // The step the Adonis worker OWNS. It stamps a per-run random `token` generated HERE, so the value
    // the aviary run ends up with can ONLY have travelled over the shared wire from this worker — the
    // assertion binds to it (a constant, or a wire that didn't actually carry the result, can't pass).
    let capturedOutput: unknown;
    runtime.registerStep('adonis-echo', (input) => {
      const n =
        input && typeof input === 'object' && 'n' in input
          ? (input as { n: unknown }).n
          : undefined;
      capturedOutput = {
        echoed: input,
        runtime: 'node',
        sdk: '@adonis-agora/durable',
        nPlusOne: typeof n === 'number' ? n + 1 : null,
        token: randomUUID(),
      };
      return capturedOutput;
    });

    await runtime.start();

    // A raw client for wire evidence + waiting on the advertised descriptor.
    const raw = new Redis(REDIS_URL as string);
    closers.push(() => raw.disconnect());

    // Wait until the Adonis worker's handshake descriptor is live on the shared Redis (the aviary
    // control-plane's negotiation guard SCANs exactly this key before it will route the dispatch).
    await waitFor(
      `Adonis worker descriptor on ${prefix}-worker-descriptor:adonis-echo:*`,
      async () => {
        const keys = await scanKeys(raw, `${prefix}-worker-descriptor:adonis-echo:*`);
        return keys.length > 0 ? keys : undefined;
      },
      15_000,
    );
    const descriptorKeys = await scanKeys(raw, `${prefix}-worker-descriptor:adonis-echo:*`);
    const advertised = JSON.parse((await raw.get(descriptorKeys[0])) as string);
    expect(advertised.runtime).toBe('node');
    expect(advertised.steps).toContain('adonis-echo');

    // --- Aviary side: spawn the REAL nestjs-durable control-plane, which dispatches `adonis-echo` ---
    const cpLog: string[] = [];
    let resultLine: string | undefined;
    const cp: ChildProcess = spawn(process.execPath, [CP_SCRIPT, prefix, runId], {
      env: {
        ...process.env,
        DURABLE_INTEROP_REDIS_URL: REDIS_URL,
        DURABLE_INTEROP_NESTJS: NESTJS_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    cp.stdout?.on('data', (b: Buffer) => {
      stdoutBuf += b.toString();
      const lines = stdoutBuf.split('\n');
      // Keep the trailing partial (no newline yet) buffered for the next chunk.
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        cpLog.push(`[cp-out] ${line}`);
        if (line.startsWith('RESULT ')) resultLine = line.slice('RESULT '.length);
      }
    });
    cp.stderr?.on('data', (b: Buffer) => cpLog.push(`[cp-err] ${b.toString().trim()}`));
    closers.push(
      () =>
        new Promise<void>((res) => {
          cp.once('exit', () => res());
          cp.kill('SIGTERM');
          setTimeout(() => {
            cp.kill('SIGKILL');
            res();
          }, 3000);
        }),
    );

    // --- ASSERT: the aviary control-plane's run reached the Adonis-computed result ------------------
    await waitFor(
      `aviary control-plane RESULT\n${cpLog.join('\n')}`,
      async () => resultLine,
      45_000,
    );
    const cpResult = JSON.parse(resultLine as string) as {
      status: string;
      output: unknown;
      error: unknown;
    };

    expect(
      cpResult.status,
      `aviary run did not complete: ${JSON.stringify(cpResult)}\n${cpLog.join('\n')}`,
    ).toBe('completed');

    // The output the AVIARY run carries must be EXACTLY the object the ADONIS worker produced (including
    // the per-run random `token`) — proving the aviary control-plane dispatched, the Adonis worker
    // executed, and the byte-compatible result flowed back over the shared wire to resume the run.
    expect(capturedOutput, 'the Adonis worker never ran its handler').toBeDefined();
    expect(cpResult.output).toEqual(capturedOutput);
    expect((cpResult.output as { runtime: string }).runtime).toBe('node');
    expect((cpResult.output as { nPlusOne: number }).nPlusOne).toBe(42);

    // --- Live wire evidence: the shared BullMQ keyspace both ecosystems used ------------------------
    const bullKeys = await scanKeys(raw, 'bull:*');
    const shared = bullKeys.filter((k) => k.includes(prefix)).sort();
    // The task queue (aviary -> Adonis) and the results queue (Adonis -> aviary) both exist under one
    // `bull:` keyspace, under the SAME prefix — the byte-level shared wire.
    expect(shared.some((k) => k.startsWith(`bull:${prefix}-tasks-adonis-echo:`))).toBe(true);
    expect(shared.some((k) => k.startsWith(`bull:${prefix}-results:`))).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      [
        '--- CROSS-ECOSYSTEM WIRE EVIDENCE (REVERSE: aviary CP -> Adonis worker) ---',
        `prefix: ${prefix}`,
        `adonis worker descriptor: ${JSON.stringify(advertised)}`,
        `descriptor keys: ${descriptorKeys.join(', ')}`,
        `aviary run.output (computed in Adonis): ${JSON.stringify(cpResult.output)}`,
        `shared bull keys:\n  ${shared.join('\n  ')}`,
        cpLog.length ? `control-plane log:\n${cpLog.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }, 90_000);
});
