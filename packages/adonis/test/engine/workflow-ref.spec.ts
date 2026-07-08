import { describe, expect, it } from 'vitest';
import { workflowName } from '../../src/workflow-ref.js';

describe('workflowName (workflow ref resolution)', () => {
  it('returns a string ref as-is (the cross-runtime form)', () => {
    expect(workflowName('shipping')).toBe('shipping');
  });

  it('resolves a class to the name on its `static workflow` config', () => {
    class ShippingWorkflow {
      static workflow = { name: 'shipping' };
      async run() {
        return 'ok';
      }
    }
    expect(workflowName(ShippingWorkflow as never)).toBe('shipping');
  });

  it('throws for a class with no registered name (no `static workflow`)', () => {
    class NoConfig {}
    expect(() => workflowName(NoConfig as never)).toThrow(/NoConfig/);
  });
});
