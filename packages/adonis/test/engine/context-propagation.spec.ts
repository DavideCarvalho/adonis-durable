import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask } from '../../src/interfaces.js';
import { runStepHandler } from '../../src/protocol.js';

const CONTEXT_SET = Symbol.for('@agora/context:set');

function task(context?: Record<string, unknown>): RemoteTask {
  return {
    runId: 'r1',
    seq: 0,
    name: 'payments.charge',
    stepId: 'r1:0',
    group: 'payments',
    input: { amount: 10 },
    ...(context ? { context } : {}),
  };
}

describe('cross-process context propagation (worker restore)', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[CONTEXT_SET];
  });

  it('restores the task context snapshot into the context:set slot BEFORE the handler runs', async () => {
    const installed: Array<Record<string, unknown>> = [];
    (globalThis as Record<symbol, unknown>)[CONTEXT_SET] = (s: Record<string, unknown>) => {
      installed.push(s);
    };

    let ctxSeenByHandler: Record<string, unknown> | undefined;
    const snapshot = { userRef: 'user-42', tenantId: 'acme', traceId: 'trace-abc' };
    const result = await runStepHandler(task(snapshot), () => {
      // The slot was written before the handler body executes.
      ctxSeenByHandler = installed[0];
      return 'ok';
    });

    expect(result.status).toBe('completed');
    expect(installed).toEqual([snapshot]); // the snapshot rode the task and was restored
    expect(ctxSeenByHandler).toEqual(snapshot); // restored BEFORE the handler ran
  });

  it('is a no-op when no context snapshot is on the task', async () => {
    const installed: Array<unknown> = [];
    (globalThis as Record<symbol, unknown>)[CONTEXT_SET] = (s: unknown) => installed.push(s);
    const result = await runStepHandler(task(), () => 'ok');
    expect(result.status).toBe('completed');
    expect(installed).toEqual([]);
  });

  it('is a no-op (best-effort) when the context:set slot is not installed', async () => {
    const result = await runStepHandler(task({ userRef: 'u' }), () => 'ok');
    expect(result.status).toBe('completed');
  });

  it('swallows a throwing set slot — propagation never fails the step', async () => {
    (globalThis as Record<symbol, unknown>)[CONTEXT_SET] = () => {
      throw new Error('boom');
    };
    const result = await runStepHandler(task({ userRef: 'u' }), () => 'handled');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('handled');
  });
});
