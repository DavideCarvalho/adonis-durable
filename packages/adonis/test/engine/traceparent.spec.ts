import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('distributed tracing — traceparent propagation to workers', () => {
  it('injects the configured traceparent into dispatched remote tasks', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const transport: Transport = {
      async dispatch(task) {
        dispatched.push(task);
      },
      onResult(_h: (r: StepResult) => Promise<void>) {},
      onHeartbeat() {},
    };
    const engine = new WorkflowEngine({
      store,
      transport,
      traceparent: () => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('ext.ping', {});
      return 'x';
    });

    await startRun(engine, 'wf', {}, 'r1');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.traceparent).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
  });

  it('omits traceparent when no provider is configured', async () => {
    const store = new InMemoryStateStore();
    const dispatched: RemoteTask[] = [];
    const transport: Transport = {
      async dispatch(task) {
        dispatched.push(task);
      },
      onResult() {},
      onHeartbeat() {},
    };
    const engine = new WorkflowEngine({ store, transport });
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('ext.ping', {});
      return 'x';
    });

    await startRun(engine, 'wf', {}, 'r1');
    expect(dispatched[0]?.traceparent).toBeUndefined();
  });
});
