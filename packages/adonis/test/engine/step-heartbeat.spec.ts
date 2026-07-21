import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';

/** Wait until `cond()` is true (heartbeat persistence is fire-and-forget) or fail after a budget. */
async function until(cond: () => boolean | Promise<boolean>, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The full liveness lane, end to end: a remote step handler calls `log.heartbeat(progress)` →
 * the transport carries the beat → the engine persists it on the step's checkpoint — so a status
 * surface in ANOTHER process can tell "alive mid-flight" from "hung" without domain tables.
 */
describe('step heartbeat: handler → transport → checkpoint', () => {
  it('persists the latest beat (with progress) on the pending remote checkpoint', async () => {
    const store = new InMemoryStateStore();
    const transport = new EventEmitterTransport();
    const engine = new WorkflowEngine({ store, transport });

    // The handler beats, then WAITS until the test releases it — freezing the step mid-flight so
    // the assertion reads the checkpoint of a genuinely in-progress step, not a settled one.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport.handle('lote.colher', async (_input, log) => {
      log.heartbeat({ done: 12, total: 50 });
      await gate;
      return 'ok';
    });

    engine.register('harvest', '1', async (ctx) => {
      // timeoutMs → in-memory await path, the long-step shape heartbeats exist for.
      await ctx.step('lote.colher', { lote: 1 }, { timeoutMs: 60_000 });
      return 'done';
    });

    await engine.start('harvest', {}, 'run-hb');
    await until(async () => {
      const cps = await store.listCheckpoints('run-hb');
      return cps.some((cp) => cp.lastHeartbeatAt !== undefined);
    });

    const cp = (await store.listCheckpoints('run-hb')).find((c) => c.name === 'lote.colher');
    expect(cp?.status).toBe('pending');
    expect(cp?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(cp?.heartbeatProgress).toEqual({ done: 12, total: 50 });

    release();
    const final = await engine.waitForRun('run-hb', { terminal: true });
    expect(final.status).toBe('completed');
  });
});
