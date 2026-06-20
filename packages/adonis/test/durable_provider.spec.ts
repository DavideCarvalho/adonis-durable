import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';

/** Minimal Adonis container/app stand-in capturing the singleton factory. */
function fakeApp(config: DurableConfig = {}) {
  let factory: (() => unknown) | undefined;
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    container: {
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
    },
  } as unknown as ApplicationService;
  return { app, resolve: async () => (await factory?.()) as WorkflowEngine };
}

describe('DurableProvider', () => {
  it('binds a WorkflowEngine built from config (in-memory defaults)', async () => {
    const { app, resolve } = fakeApp();
    new DurableProvider(app).register();

    const engine = await resolve();
    expect(engine).toBeInstanceOf(WorkflowEngine);

    // The engine works end-to-end through the binding: register + run a workflow.
    engine.register('greet', '1', async (ctx) => {
      const a = await ctx.step('a', async () => 21);
      return a * 2;
    });
    await engine.start('greet', {}, 'run-1');
    const result = await engine.waitForRun('run-1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe(42);
  });

  it('uses the configured store', async () => {
    const { app, resolve } = fakeApp({ instanceId: 'engine-a' });
    new DurableProvider(app).register();
    expect(await resolve()).toBeInstanceOf(WorkflowEngine);
  });

  it('consumes the @agora/otel:traceparent global slot when present (no break)', async () => {
    const OTEL_TRACEPARENT = Symbol.for('@agora/otel:traceparent');
    const g = globalThis as Record<symbol, unknown>;
    g[OTEL_TRACEPARENT] = () => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    try {
      const { app, resolve } = fakeApp();
      new DurableProvider(app).register();
      const engine = await resolve();
      engine.register('wf', '1', async (ctx) => ctx.step('s', async () => 'ok'));
      await engine.start('wf', {}, 'otel-run');
      const result = await engine.waitForRun('otel-run');
      expect(result.status).toBe('completed');
      expect(result.output).toBe('ok');
    } finally {
      delete g[OTEL_TRACEPARENT];
    }
  });
});
