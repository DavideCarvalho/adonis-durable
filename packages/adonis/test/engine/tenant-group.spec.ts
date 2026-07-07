import { describe, expect, it } from 'vitest';
import { sanitizeQueueToken, tenantGroup } from '../../src/tenant-group.js';

describe('tenantGroup', () => {
  it('returns the bare group for an undefined partition', () => {
    expect(tenantGroup('processing', undefined)).toBe('processing');
  });

  it('returns the bare group for the "default" partition', () => {
    expect(tenantGroup('processing', 'default')).toBe('processing');
  });

  it('returns the bare group for an empty-string partition', () => {
    expect(tenantGroup('processing', '')).toBe('processing');
  });

  it('suffixes the group with the partition for any other value', () => {
    expect(tenantGroup('processing', 'davi-local')).toBe('processing@davi-local');
  });
});

describe('sanitizeQueueToken', () => {
  it('replaces every colon with a hyphen (brokers forbid ":" in queue names)', () => {
    expect(sanitizeQueueToken('extraction:page')).toBe('extraction-page');
    expect(sanitizeQueueToken('a:b:c')).toBe('a-b-c');
  });

  it('leaves "." as-is (legal in a queue name — a common namespacing separator)', () => {
    expect(sanitizeQueueToken('payments.charge')).toBe('payments.charge');
  });

  it('is a no-op for a token with no colon', () => {
    expect(sanitizeQueueToken('plain')).toBe('plain');
  });
});
