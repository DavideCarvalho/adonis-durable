import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * In-flight visibility for local steps: the body's start is announced (`step.started`) and — unless
 * `trackStepStart` is off — checkpointed as `running`, so a long step shows up in the dashboard the
 * moment it begins rather than only on completion.
 */
describe('WorkflowEngine — local step start visibility', () => {
  it('persists a `running` checkpoint and emits `step.started` while the body is in flight', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'step.started') started.push(event.name ?? '');
    });

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('slow', async () => {
        await gate;
        return 1;
      });
      return 'ok';
    });

    await engine.start('wf', {}, 'run1');

    // Body is parked on the gate — the step is mid-flight, not finished.
    await vi.waitFor(async () => {
      expect((await store.getCheckpoint('run1', 0))?.status).toBe('running');
    });
    expect(started).toEqual(['slow']);

    release();
    await engine.waitForRun('run1');

    // The terminal write overwrites the `running` placeholder.
    expect((await store.getCheckpoint('run1', 0))?.status).toBe('completed');
  });

  it('still emits `step.started` but writes no checkpoint when `trackStepStart` is off', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, trackStepStart: false });

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'step.started') started.push(event.name ?? '');
    });

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('slow', async () => {
        await gate;
        return 1;
      });
      return 'ok';
    });

    await engine.start('wf', {}, 'run1');

    // The live event fires (the SSE view still sees the start)...
    await vi.waitFor(() => {
      expect(started).toEqual(['slow']);
    });
    // ...but with persistence off there's no in-flight checkpoint to find.
    expect(await store.getCheckpoint('run1', 0)).toBeNull();

    release();
    await engine.waitForRun('run1');

    expect((await store.getCheckpoint('run1', 0))?.status).toBe('completed');
  });
});
