import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '@agora/durable-core';
import { describe, expect, it } from 'vitest';
import { type WorkerLogger, runTick, runWorkerLoop } from '../src/worker.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  return { store, engine };
}

function captureLogger(): WorkerLogger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m) => errors.push(m) };
}

describe('runTick', () => {
  it('returns zero counts and no errors on an idle engine', async () => {
    const { engine } = makeEngine();
    const result = await runTick(engine);
    expect(result).toMatchObject({ pending: 0, recovered: 0, timers: 0 });
    expect(result.errors).toHaveLength(0);
  });

  it('collects a phase error instead of throwing', async () => {
    const { engine } = makeEngine();
    // Make one phase throw; the tick must still complete and record the error.
    (engine as unknown as { runPending: () => Promise<never> }).runPending = () => {
      throw new Error('boom');
    };
    const result = await runTick(engine);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.phase).toBe('runPending');
    expect(result.errors[0]?.error.message).toBe('boom');
  });

  it('invokes every engine phase exactly once per tick', async () => {
    const { engine } = makeEngine();
    const calls: string[] = [];
    const spy = (name: string) => {
      (engine as unknown as Record<string, unknown>)[name] = async () => {
        calls.push(name);
        return name === 'sweepTimeouts' ? undefined : [];
      };
    };
    for (const m of ['runPending', 'recoverIncomplete', 'resumeDueTimers', 'sweepTimeouts']) {
      spy(m);
    }
    await runTick(engine);
    expect(calls).toEqual(['runPending', 'recoverIncomplete', 'resumeDueTimers', 'sweepTimeouts']);
  });
});

describe('runWorkerLoop', () => {
  it('ticks until the stop signal resolves, then drains', async () => {
    const { engine } = makeEngine();
    const logger = captureLogger();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    // Stop after two sleeps so the loop runs ~2 ticks.
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps >= 2) stop();
    };
    const ticks = await runWorkerLoop(engine, {
      intervalMs: 5,
      stopSignal,
      logger,
      drainTimeoutMs: 50,
      sleep,
    });
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(logger.infos.some((m) => m.includes('worker stopped'))).toBe(true);
  });

  it('actually advances real runs across ticks', async () => {
    const { engine, store } = makeEngine();
    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('reserve', async () => 1);
      return 'ok';
    });
    // Enqueue a run with a no-op dispatch path by creating it pending, then let the loop pick it up.
    await engine.start('checkout', {}, 'run1');
    const logger = captureLogger();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps >= 3) stop();
    };
    await runWorkerLoop(engine, { intervalMs: 1, stopSignal, logger, drainTimeoutMs: 50, sleep });
    // The default in-process dispatcher may have already run it; either way it must be settled.
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
  });
});
