import { describe, expect, it } from 'vitest';
import { transports } from '../../../src/transports/factory.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/** A fake booted app exposing only `config.get('queue', …)` — what the factory reads. */
function fakeCtx(queueConfig: unknown) {
  return {
    app: {
      container: {
        make: async () => {
          throw new Error('not used');
        },
      },
      config: {
        get: (key: string, fallback?: unknown) => (key === 'queue' ? queueConfig : fallback),
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural test double for TransportContext
  } as any;
}

describe('transports.queue — connection resolution from config/queue.ts', () => {
  it('resolves a raw adapter-factory entry by connection name', async () => {
    const ctx = fakeCtx({ default: 'redis', adapters: { redis: () => new MockAdapter() } });
    const transport = await transports.queue({ connection: 'redis' })(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('uses the default connection when none is given', async () => {
    const ctx = fakeCtx({ default: 'redis', adapters: { redis: () => new MockAdapter() } });
    const transport = await transports.queue()(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('resolves a config-provider entry via resolver(app)', async () => {
    const ctx = fakeCtx({ adapters: { redis: { resolver: () => () => new MockAdapter() } } });
    const transport = await transports.queue({ connection: 'redis' })(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('lets an explicit adapter override take precedence over connection', async () => {
    const ctx = fakeCtx({ adapters: {} }); // no connections configured
    const transport = await transports.queue({ adapter: () => new MockAdapter() })(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('throws on an unknown connection name', async () => {
    const ctx = fakeCtx({ default: 'redis', adapters: { redis: () => new MockAdapter() } });
    await expect(transports.queue({ connection: 'nope' })(ctx)).rejects.toThrow(
      /unknown @adonisjs\/queue connection "nope"/,
    );
  });

  it('throws when no connection is given and config/queue.ts has no default', async () => {
    const ctx = fakeCtx({ adapters: {} });
    await expect(transports.queue()(ctx)).rejects.toThrow(/needs a `connection`/);
  });
});
