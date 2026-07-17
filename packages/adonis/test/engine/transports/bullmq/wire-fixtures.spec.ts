import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  WorkflowTask,
} from '../../../../src/interfaces.js';

/**
 * Golden wire fixtures — the byte-canonical JSON each DTO crosses the BullMQ queue as (spec §6.3,
 * Appendix B). Every DTO rides as PLAIN JSON with NO envelope (the DTO is the job's `data`), so the
 * contract is: constructing the DTO and `JSON.stringify`ing it yields EXACTLY the fixture bytes, and
 * the fixture parses back to the DTO. A Python/NestJS SDK asserts the same fixtures — this is what
 * keeps polyglot interop from rotting.
 */
const fixture = (name: string): { text: string; value: unknown } => {
  const path = fileURLToPath(new URL(`../../../fixtures/wire/${name}`, import.meta.url));
  const text = readFileSync(path, 'utf8').trim();
  return { text, value: JSON.parse(text) };
};

/** The canonical compact bytes of a fixture (order-preserving), for a byte-exact stringify assertion. */
const canonical = (f: { value: unknown }): string => JSON.stringify(f.value);

describe('bullmq wire fixtures (byte-compat with aviary)', () => {
  it('task.step — a RemoteTask serializes to and parses from the golden bytes', () => {
    const f = fixture('task.step.json');
    const task: RemoteTask = {
      runId: 'run-abc',
      seq: 3,
      name: 'payments.charge-card',
      stepId: 'run-abc:3',
      group: 'payments.charge-card',
      input: { amount: 1200, currency: 'USD' },
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      context: { tenant: 'acme', userRef: 'user-42' },
      transport: 'primary',
      priority: 5,
      attempt: 1,
    };
    expect(JSON.stringify(task)).toBe(canonical(f)); // byte-exact
    expect(task).toEqual(f.value); // semantic
  });

  it('task.workflow — a WorkflowTask serializes to and parses from the golden bytes', () => {
    const f = fixture('task.workflow.json');
    const task: WorkflowTask = {
      taskId: 'run-xyz#2',
      runId: 'run-xyz',
      workflow: 'checkout',
      workflowVersion: '1.0.0',
      input: { cartId: 'cart-9' },
      history: [{ seq: 0, kind: 'step', name: 'inventory.reserve', output: { reserved: true } }],
      pendingSignals: [{ seq: 1, signal: 'payment.settled', payload: { amount: 1200 } }],
      group: 'checkout',
      transport: 'primary',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      priority: 5,
      attempt: 1,
    };
    expect(JSON.stringify(task)).toBe(canonical(f));
    expect(task).toEqual(f.value);
  });

  it('result — a completed StepResult serializes to and parses from the golden bytes', () => {
    const f = fixture('result.json');
    const result: StepResult = {
      runId: 'run-abc',
      seq: 3,
      stepId: 'run-abc:3',
      status: 'completed',
      output: { chargeId: 'ch_123', amount: 1200 },
      startedAt: 1752710400000,
      events: [{ at: 1752710400500, level: 'info', message: 'charged card' }],
    };
    expect(JSON.stringify(result)).toBe(canonical(f));
    expect(result).toEqual(f.value);
  });

  it('result — carries NO `name` field (correlation is purely runId/seq/stepId)', () => {
    const f = fixture('result.json');
    expect(Object.keys(f.value as object)).not.toContain('name');
  });

  it('heartbeat — a Heartbeat serializes to and parses from the golden bytes', () => {
    const f = fixture('heartbeat.json');
    const beat: Heartbeat = {
      runId: 'run-abc',
      seq: 3,
      stepId: 'run-abc:3',
      group: 'payments.charge-card',
    };
    expect(JSON.stringify(beat)).toBe(canonical(f));
    expect(beat).toEqual(f.value);
  });

  describe('serialization rules (§6.3) proven by construction', () => {
    it('a RemoteTask without a priority omits the `priority` key entirely', () => {
      const task: RemoteTask = {
        runId: 'r',
        seq: 1,
        name: 'n',
        stepId: 'r:1',
        group: 'n',
        input: null,
        attempt: 0,
      };
      expect(JSON.stringify(task)).not.toContain('priority');
    });

    it('a failed StepResult carries the StepError shape {message,code?,retryable?}, omitting absent optionals', () => {
      const failed: StepResult = {
        runId: 'r',
        seq: 1,
        stepId: 'r:1',
        status: 'failed',
        error: { message: 'card declined', code: 'declined', retryable: false },
      };
      // no `stack` when absent, no `name`, no `output` when absent
      expect(JSON.stringify(failed)).toBe(
        '{"runId":"r","seq":1,"stepId":"r:1","status":"failed","error":{"message":"card declined","code":"declined","retryable":false}}',
      );
    });
  });
});
