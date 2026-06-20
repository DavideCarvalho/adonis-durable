import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AdmissionBackend } from './admission.js';
import { WorkflowEngine } from './engine.js';
import type { Admission, AdmissionItem, QueueConfig } from './queue.js';
import { remoteStep } from './remote-step-factory.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';
import { InMemoryTransport } from './testing/in-memory-transport.js';

const chargeCard = remoteStep({
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
});

/** Records every admission decision so we can assert the engine routes through the injected backend. */
class RecordingBackend implements AdmissionBackend {
  readonly registered: string[] = [];
  readonly admits: Array<{ queue: string; item: AdmissionItem }> = [];
  readonly releases: string[] = [];
  register(config: QueueConfig): void {
    this.registered.push(config.name);
  }
  handles(queue: string): boolean {
    return this.registered.includes(queue);
  }
  async tryAdmit(queue: string, item: AdmissionItem): Promise<Admission> {
    this.admits.push({ queue, item });
    return { ok: true };
  }
  async release(queue: string, _slotId: string): Promise<void> {
    this.releases.push(queue);
  }
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('WorkflowEngine routes flow-control through an injected AdmissionBackend', () => {
  it('consults the backend on admit and release for a queued remote step', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (i: { amount: number }) => ({
      chargeId: `ch_${i.amount}`,
    }));
    const backend = new RecordingBackend();

    const engine = new WorkflowEngine({ store, transport, admission: backend });
    engine.registerQueue({ name: 'charges', concurrency: 1 });
    engine.register('checkout', '1', async (ctx) => {
      const c = await ctx.call(chargeCard, { amount: 42 }, { queue: 'charges', priority: 5 });
      return c.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1');
    await settle(store, 'run1');

    expect(backend.registered).toEqual(['charges']);
    expect(backend.admits).toHaveLength(1);
    expect(backend.admits[0]?.queue).toBe('charges');
    expect(backend.admits[0]?.item.priority).toBe(5);
    expect(backend.releases).toEqual(['charges']);
  });
});
