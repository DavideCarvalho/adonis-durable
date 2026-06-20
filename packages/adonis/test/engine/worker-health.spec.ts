import { WorkflowEngine } from '../../src/engine.js';
import type { GroupHealth, Transport } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/** A transport that reports canned worker-health — exercises the engine's aggregation, not a broker. */
class HealthTransport implements Transport {
  constructor(
    private readonly health: Record<string, GroupHealth>,
    private readonly discovered: string[],
  ) {}
  async dispatch(): Promise<void> {}
  onResult(): void {}
  onHeartbeat(): void {}
  async groupHealth(group: string): Promise<GroupHealth> {
    return this.health[group] ?? { group, depth: 0, liveWorkers: [] };
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.discovered;
  }
}

describe('engine.workerHealth', () => {
  it('covers registered groups (even with zero workers) UNION groups discovered from heartbeats', async () => {
    const store = new InMemoryStateStore();
    const transport = new HealthTransport(
      {
        // Registered remote group with backlog and NO live worker — the alert case.
        'processing-workflows': { group: 'processing-workflows', depth: 3, liveWorkers: [] },
        // Local-step group, not a registration — only known via its live heartbeats.
        pipeline: {
          group: 'pipeline',
          depth: 0,
          liveWorkers: [{ group: 'pipeline', instanceId: 'ts-h-1', lastBeatAt: 1700 }],
        },
      },
      ['pipeline'],
    );
    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('processing', '1', {
      group: 'processing-workflows',
      executor: {
        async advance(run) {
          return { taskId: 't', runId: run.id, status: 'completed', commands: [], output: {} };
        },
      },
    });

    const health = await engine.workerHealth();
    const byGroup = new Map(health.map((h) => [h.group, h]));

    const proc = byGroup.get('processing-workflows');
    expect(proc?.depth).toBe(3);
    expect(proc?.liveWorkers).toHaveLength(0); // registered group surfaces even with no workers
    expect((proc?.depth ?? 0) > 0 && (proc?.liveWorkers.length ?? 0) === 0).toBe(true); // alert state

    const pipeline = byGroup.get('pipeline'); // discovered purely from heartbeats
    expect(pipeline?.liveWorkers).toHaveLength(1);
  });

  it('is empty when the transport cannot introspect health', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    expect(await engine.workerHealth()).toEqual([]);
  });
});
