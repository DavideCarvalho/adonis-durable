import { z } from 'zod';
import { remoteStep } from './remote-step-factory.js';

describe('remoteStep', () => {
  it('builds a typed, branded remote step definition with defaults', () => {
    const step = remoteStep({
      name: 'payments.charge-card',
      group: 'payments',
      input: z.object({ amount: z.number() }),
      output: z.object({ chargeId: z.string() }),
      retries: 3,
    });

    expect(step.__remote).toBe(true);
    expect(step.name).toBe('payments.charge-card');
    expect(step.group).toBe('payments');
    expect(step.retries).toBe(3);
    expect(step.input.parse({ amount: 10 })).toEqual({ amount: 10 });
  });

  it('defaults the group to the step name prefix when omitted', () => {
    const step = remoteStep({
      name: 'payments.charge-card',
      input: z.object({}),
      output: z.object({}),
    });

    expect(step.group).toBe('payments');
  });
});
