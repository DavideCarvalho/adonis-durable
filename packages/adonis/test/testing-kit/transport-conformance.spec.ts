import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '../../src/index.js';
import { assertTransportConformance } from '../../src/testing-kit/transport-conformance.js';

describe('assertTransportConformance', () => {
  it('passes for the in-memory transport (the reference implementation)', async () => {
    await expect(assertTransportConformance(new InMemoryTransport())).resolves.toBeUndefined();
  });
});
