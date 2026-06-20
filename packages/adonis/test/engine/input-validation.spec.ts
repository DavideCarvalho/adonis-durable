import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('validateInput at start', () => {
  it('rejects invalid input before creating the run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('checkout', '1', async () => 'ok', {
      validateInput: (input) => {
        if (typeof (input as { orderId?: unknown }).orderId !== 'string') {
          throw new Error('orderId must be a string');
        }
      },
    });

    await expect(engine.start('checkout', { orderId: 123 }, 'bad')).rejects.toThrow(/orderId/);
    expect(await store.getRun('bad')).toBeNull(); // no run created

    const ok = await startRun(engine, 'checkout', { orderId: 'o1' }, 'good');
    expect(ok.status).toBe('completed');
  });
});
