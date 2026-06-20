import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { Heartbeat, RemoteTask, StepResult } from '../interfaces.js';
import { DbTransport } from './db.js';
import { TRANSPORT_TABLES } from './db-schema.js';
import { makeTransportDb } from './db-helpers.js';

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  stepId: 'r1:1',
  name: 'math.double',
  group: 'math',
  input: { n: 21 },
  attempt: 1,
  ...over,
});

async function waitFor(fn: () => Promise<boolean>, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met within budget');
}

describe('DbTransport (unit)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  let db: Database;

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    if (db) await db.manager.closeAll();
  });

  function transport(
    opts: Partial<ConstructorParameters<typeof DbTransport>[0]> = {},
  ): DbTransport {
    const t = new DbTransport({ db, pollIntervalMs: 5, ...opts });
    cleanups.push(() => t.close());
    return t;
  }

  it('dispatch inserts a pending task row (idempotent per stepId)', async () => {
    db = await makeTransportDb();
    const t = transport();
    await t.dispatch(task());
    await t.dispatch(task()); // redelivery — must not duplicate

    const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].step_id).toBe('r1:1');
    expect(rows[0].claimed_at).toBeNull();
    expect(JSON.parse(rows[0].input)).toEqual({ n: 21 });
  });

  it('two worker instances never double-claim the same task', async () => {
    db = await makeTransportDb();
    const engine = transport();
    // 10 tasks, each a distinct step.
    for (let i = 0; i < 10; i++) {
      await engine.dispatch(task({ seq: i, stepId: `r1:${i}` }));
    }

    const seenA: string[] = [];
    const seenB: string[] = [];
    const workerA = transport({ group: 'math', instanceId: 'A' });
    const workerB = transport({ group: 'math', instanceId: 'B' });
    workerA.handle('math.double', (input) => {
      seenA.push(JSON.stringify(input));
      return { ok: true };
    });
    workerB.handle('math.double', (input) => {
      seenB.push(JSON.stringify(input));
      return { ok: true };
    });

    await waitFor(async () => seenA.length + seenB.length === 10);
    // Every task ran exactly once across the two instances — no double-claim.
    expect(seenA.length + seenB.length).toBe(10);
    const tasksLeft = await db.connection().from(TRANSPORT_TABLES.tasks).count('* as c');
    expect(Number(tasksLeft[0].c)).toBe(0);
  });

  it('delivers a worker result row to the engine onResult handler', async () => {
    db = await makeTransportDb();
    const engine = transport();
    const worker = transport({ group: 'math' });

    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });
    worker.handle('math.double', (input) => {
      const { n } = input as { n: number };
      return { result: n * 2 };
    });

    await engine.dispatch(task());
    await waitFor(async () => results.length === 1);

    expect(results[0].status).toBe('completed');
    expect(results[0].stepId).toBe('r1:1');
    expect(results[0].output).toEqual({ result: 42 });
    // Result row consumed + deleted.
    const left = await db.connection().from(TRANSPORT_TABLES.results).count('* as c');
    expect(Number(left[0].c)).toBe(0);
  });

  it('a thrown handler produces a failed result carrying retryable', async () => {
    db = await makeTransportDb();
    const engine = transport();
    const worker = transport({ group: 'math' });
    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });
    worker.handle('math.double', () => {
      throw Object.assign(new Error('declined'), { retryable: false });
    });

    await engine.dispatch(task());
    await waitFor(async () => results.length === 1);
    expect(results[0].status).toBe('failed');
    expect(results[0].error?.message).toBe('declined');
    expect(results[0].error?.retryable).toBe(false);
  });

  it('polls heartbeat rows and delivers them to the engine', async () => {
    db = await makeTransportDb();
    const engine = transport();
    const worker = transport({ group: 'math' });

    const beats: Heartbeat[] = [];
    engine.onHeartbeat(async (b) => {
      beats.push(b);
    });

    const beat: Heartbeat = { runId: 'r1', seq: 1, stepId: 'r1:1', group: 'math' };
    await worker.heartbeat(beat);
    await waitFor(async () => beats.length === 1);

    expect(beats[0]).toEqual(beat);
    const left = await db.connection().from(TRANSPORT_TABLES.heartbeats).count('* as c');
    expect(Number(left[0].c)).toBe(0);
  });

  it('a stale claim is reclaimed after the lease expires', async () => {
    db = await makeTransportDb();
    const engine = transport();
    await engine.dispatch(task());

    // Simulate a crashed claimer: stamp the row with an ancient claim that never got deleted.
    await db
      .connection()
      .from(TRANSPORT_TABLES.tasks)
      .where('step_id', 'r1:1')
      .update({ claimed_by: 'dead', claimed_at: Date.now() - 60_000 });

    const seen: string[] = [];
    const worker = transport({ group: 'math', leaseMs: 1000 });
    worker.handle('math.double', (input) => {
      seen.push(JSON.stringify(input));
      return { ok: true };
    });

    await waitFor(async () => seen.length === 1);
    expect(seen).toHaveLength(1);
  });

  it('publishControl stamps `from` and onControl delivers the message', async () => {
    db = await makeTransportDb();
    const a = transport({ instanceId: 'A' });
    const b = transport({ instanceId: 'B' });
    const got: Array<{ kind: string; from?: string }> = [];
    b.onControl((msg) => got.push(msg));

    await a.publishControl({ kind: 'cancel', runId: 'r1' });
    await waitFor(async () => got.length === 1);
    expect(got[0].kind).toBe('cancel');
    expect(got[0].from).toBe('A');
  });
});
