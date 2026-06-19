import { describe, expect, it } from 'vitest';
import { WORKFLOW_NAME_KEY, workflowName } from './workflow-ref.js';

describe('workflowName (workflow ref resolution)', () => {
  it('returns a string ref as-is (the cross-runtime form)', () => {
    expect(workflowName('shipping')).toBe('shipping');
  });

  it('resolves a class to the name stamped on it by @Workflow', () => {
    class ShippingWorkflow {}
    (ShippingWorkflow as { [WORKFLOW_NAME_KEY]?: string })[WORKFLOW_NAME_KEY] = 'shipping';
    expect(workflowName(ShippingWorkflow as never)).toBe('shipping');
  });

  it('throws for a class with no registered name (undecorated)', () => {
    class NotDecorated {}
    expect(() => workflowName(NotDecorated as never)).toThrow(/NotDecorated/);
  });
});
