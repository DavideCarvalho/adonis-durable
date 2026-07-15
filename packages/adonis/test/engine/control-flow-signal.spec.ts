import { describe, expect, it } from 'vitest';
import { CONTROL_FLOW_SIGNAL, isWorkflowControlFlowSignal } from '../../src/control-flow-signal.js';
import { ContinueAsNew, FatalError, WorkflowSuspended } from '../../src/errors.js';

describe('isWorkflowControlFlowSignal', () => {
  it('recognizes WorkflowSuspended', () => {
    expect(isWorkflowControlFlowSignal(new WorkflowSuspended())).toBe(true);
    expect(isWorkflowControlFlowSignal(new WorkflowSuspended(Date.now() + 1000))).toBe(true);
  });

  it('recognizes ContinueAsNew', () => {
    expect(isWorkflowControlFlowSignal(new ContinueAsNew({ some: 'input' }))).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isWorkflowControlFlowSignal(new Error('boom'))).toBe(false);
  });

  it('rejects a real workflow error (FatalError) — a real failure, not control-flow', () => {
    expect(isWorkflowControlFlowSignal(new FatalError('declined'))).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isWorkflowControlFlowSignal(undefined)).toBe(false);
    expect(isWorkflowControlFlowSignal(null)).toBe(false);
    expect(isWorkflowControlFlowSignal('boom')).toBe(false);
    expect(isWorkflowControlFlowSignal({ message: 'boom' })).toBe(false);
  });

  it('survives subclassing', () => {
    class CustomSuspended extends WorkflowSuspended {}
    expect(isWorkflowControlFlowSignal(new CustomSuspended())).toBe(true);
  });

  it('uses the global registry symbol (survives duplicate module copies)', () => {
    expect(CONTROL_FLOW_SIGNAL).toBe(Symbol.for('@agora/durable:control-flow'));
  });
});
