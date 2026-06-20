import { describe, expect, it } from 'vitest';
import type { AdmissionBackend, QueueConfig } from '../index.js';

/**
 * Builds an {@link AdmissionBackend} bound to the given test clock. Implementations that hold their
 * own resources (e.g. a Redis connection) should register the instance for teardown out-of-band.
 */
export type AdmissionBackendFactory = (clock: () => number) => AdmissionBackend;

/**
 * The SHARED cross-backend behavioural contract for the flow-control admission gate. Both the
 * in-process `InMemoryAdmissionBackend` and the Redis `RedisAdmissionBackend` run it, so their
 * concurrency / rate-limit / ordering semantics can never silently drift apart — backend-specific
 * concerns (leases, pub/sub, cross-pod globality) live in each adapter's own spec.
 *
 * The engine always passes a stable `waiterId`, so every gated call is order-tracked: ties with no
 * priority/fairness fall back to arrival FIFO (or LIFO when configured). These cases assert exactly
 * that, on ONE backend instance.
 */
export function runAdmissionBackendContract(
  name: string,
  makeBackend: AdmissionBackendFactory,
): void {
  describe(`AdmissionBackend contract: ${name}`, () => {
    let now = 1_000_000;
    const make = (config: QueueConfig) => {
      now = 1_000_000;
      const backend = makeBackend(() => now);
      backend.register(config);
      return backend;
    };

    it('caps concurrency: a second call blocks until the first releases', async () => {
      const b = make({ name: 'q', concurrency: 1 });
      expect((await b.tryAdmit('q', { waiterId: 'a' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: 'b' })).ok).toBe(false);
      await b.release('q', 'a');
      expect((await b.tryAdmit('q', { waiterId: 'b' })).ok).toBe(true);
    });

    it('enforces a fixed-window rate limit', async () => {
      const b = make({ name: 'q', rateLimit: { limit: 2, periodMs: 1000 } });
      expect((await b.tryAdmit('q', { waiterId: '1' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: '2' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: '3' })).ok).toBe(false);
      now += 1001;
      expect((await b.tryAdmit('q', { waiterId: '4' })).ok).toBe(true);
    });

    it('admits the highest-priority waiter first when a slot frees', async () => {
      const b = make({ name: 'q', concurrency: 1 });
      expect((await b.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: 'low', priority: 1 })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'high', priority: 9 })).ok).toBe(false);
      await b.release('q', 'holder');
      expect((await b.tryAdmit('q', { waiterId: 'low', priority: 1 })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'high', priority: 9 })).ok).toBe(true);
    });

    it('orders plain-concurrency waiters by arrival (FIFO) — no priority/fairness configured', async () => {
      const b = make({ name: 'q', concurrency: 1 });
      expect((await b.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: 'first' })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'second' })).ok).toBe(false);
      await b.release('q', 'holder');
      // The earlier arrival wins the freed slot, on every backend.
      expect((await b.tryAdmit('q', { waiterId: 'second' })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'first' })).ok).toBe(true);
    });

    it('admits the most-recent arrival first when order is LIFO', async () => {
      const b = make({ name: 'q', concurrency: 1, order: 'lifo' });
      expect((await b.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: 'first' })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'second' })).ok).toBe(false);
      await b.release('q', 'holder');
      expect((await b.tryAdmit('q', { waiterId: 'first' })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'second' })).ok).toBe(true);
    });

    it('round-robins a contended slot across fairness keys', async () => {
      const b = make({ name: 'q', concurrency: 1, fairness: 'key' });
      expect((await b.tryAdmit('q', { waiterId: 'a0', key: 'A' })).ok).toBe(true);
      expect((await b.tryAdmit('q', { waiterId: 'a1', key: 'A' })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'b0', key: 'B' })).ok).toBe(false);
      await b.release('q', 'a0');
      // B (never served) wins over A (just served), not arrival order.
      expect((await b.tryAdmit('q', { waiterId: 'a1', key: 'A' })).ok).toBe(false);
      expect((await b.tryAdmit('q', { waiterId: 'b0', key: 'B' })).ok).toBe(true);
    });

    it('leaves an unregistered queue ungated', async () => {
      const b = make({ name: 'q', concurrency: 1 });
      expect((await b.tryAdmit('other', { waiterId: 'x' })).ok).toBe(true);
      expect((await b.tryAdmit('other', { waiterId: 'y' })).ok).toBe(true);
    });
  });
}
