import { describe, expect, it } from 'vitest';
import {
  controlChannel,
  decisionsName,
  effectivePrefix,
  heartbeatChannel,
  resultsName,
  routingToken,
  stepEventsName,
  tasksName,
  workerHeartbeatKey,
  workerHeartbeatKeyPrefix,
} from '../../../../src/transports/bullmq/naming.js';

// Every assertion here is a BYTE-for-byte cross-SDK contract with the aviary (nestjs-durable) BullMQ
// transport + its Python worker (spec §6.1/§6.2). A single character drift silently splits the fleet.
describe('bullmq naming', () => {
  describe('effectivePrefix', () => {
    it('is the bare prefix when the namespace is unset/default (production byte-identical)', () => {
      expect(effectivePrefix('durable', undefined)).toBe('durable');
      expect(effectivePrefix('durable', 'default')).toBe('durable');
    });

    it('appends -<namespace> for a set, non-default namespace', () => {
      expect(effectivePrefix('durable', 'dev-alice')).toBe('durable-dev-alice');
    });
  });

  describe('routingToken', () => {
    it('sanitizes only ":" to "-" and keeps "."', () => {
      expect(routingToken('extraction:page', undefined)).toBe('extraction-page');
      expect(routingToken('payments.charge-card', undefined)).toBe('payments.charge-card');
    });

    it('suffixes @<partition> only for a non-empty/non-default partition', () => {
      expect(routingToken('proc', 'default')).toBe('proc');
      expect(routingToken('proc', '')).toBe('proc');
      expect(routingToken('proc', 'acme')).toBe('proc@acme');
      // sanitize applies to the base name before the suffix
      expect(routingToken('a:b', 'acme')).toBe('a-b@acme');
    });
  });

  describe('channel / queue / key names', () => {
    const P = 'durable';
    it('builds the exact task / results / decisions / step-events queue names', () => {
      expect(tasksName(P, 'payments.charge-card')).toBe('durable-tasks-payments.charge-card');
      expect(resultsName(P)).toBe('durable-results');
      expect(decisionsName(P)).toBe('durable-decisions');
      expect(stepEventsName(P)).toBe('durable-step-events');
    });

    it('builds the exact heartbeat + control channel names', () => {
      expect(heartbeatChannel(P)).toBe('durable-heartbeat');
      expect(controlChannel(P)).toBe('durable-control');
    });

    it('builds the exact worker-liveness key (prefix + token + instance)', () => {
      expect(workerHeartbeatKeyPrefix(P)).toBe('durable-worker-heartbeat:');
      expect(workerHeartbeatKey(P, 'proc@acme', 'ts-host-42')).toBe(
        'durable-worker-heartbeat:proc@acme:ts-host-42',
      );
    });

    it('folds a namespace into every name via the effective prefix', () => {
      const eff = effectivePrefix('durable', 'ns1');
      expect(tasksName(eff, 'proc')).toBe('durable-ns1-tasks-proc');
      expect(resultsName(eff)).toBe('durable-ns1-results');
      expect(heartbeatChannel(eff)).toBe('durable-ns1-heartbeat');
      expect(workerHeartbeatKey(eff, 'proc', 'i1')).toBe('durable-ns1-worker-heartbeat:proc:i1');
    });
  });
});
