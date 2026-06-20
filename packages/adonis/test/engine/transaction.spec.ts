import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('ctx.transaction (exactly-once)', () => {
  it('runs once, replays its checkpoint on resume (not re-run), and passes the tx handle', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    let sawTx = false;
    engine.register('w', '1', async (ctx) => {
      const amount = await ctx.transaction('charge', async (tx) => {
        runs += 1;
        sawTx = tx != null; // the store-native tx handle is provided for business writes
        return 100;
      });
      await ctx.waitForSignal('go'); // suspend so a resume replays the transaction
      return amount;
    });

    await engine.start('w', {}, 'r1');
    await engine.waitForRun('r1'); // suspended on the signal; the transaction ran exactly once
    expect(runs).toBe(1);
    expect(sawTx).toBe(true);

    await engine.signal('go', undefined); // resume → replays the transaction checkpoint, no re-run
    const r = await engine.waitForRun('r1');
    expect(r.status).toBe('completed');
    expect(r.output).toBe(100);
    expect(runs).toBe(1); // exactly once
  });

  it('errors on a store that does not support transactions', async () => {
    // A store whose `transaction` is absent.
    const base = new InMemoryStateStore();
    const noTx = new Proxy(base, {
      get(target, p) {
        if (p === 'transaction') return undefined;
        return Reflect.get(target, p);
      },
    });
    const engine = new WorkflowEngine({ store: noTx as InMemoryStateStore });
    engine.register('w', '1', async (ctx) => ctx.transaction('x', async () => 1));
    await engine.start('w', {}, 'r1');
    const r = await engine.waitForRun('r1');
    expect(r.status).toBe('failed');
    expect(r.error?.message).toMatch(/transaction/i);
  });
});
