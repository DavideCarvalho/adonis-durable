import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('retryWithInput (fix-and-replay)', () => {
  it('re-runs a failed run with a corrected input as a fresh linked run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('w', '1', async (_ctx, input) => {
      const { ok } = input as { ok: boolean };
      if (!ok) throw new Error('bad input');
      return 'shipped';
    });

    await engine.start('w', { ok: false }, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('failed');

    // Fix the input and replay → a new run with clean history.
    const retried = await engine.retryWithInput('r1', { ok: true });
    expect(retried?.runId).toMatch(/^r1~retry~/);
    const result = await engine.waitForRun(retried?.runId as string);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('shipped');

    // The original is untouched.
    expect((await store.getRun('r1'))?.status).toBe('failed');
  });
});
