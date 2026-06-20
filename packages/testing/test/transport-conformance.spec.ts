import { InMemoryTransport } from '@agora/durable-core';
import { describe, expect, it } from 'vitest';
import { assertTransportConformance } from '../src/transport-conformance.js';

describe('assertTransportConformance', () => {
  it('passes for the in-memory transport (the reference implementation)', async () => {
    await expect(assertTransportConformance(new InMemoryTransport())).resolves.toBeUndefined();
  });
});
