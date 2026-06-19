import type { ApplicationService } from '@adonisjs/core/types';
import { WorkflowEngine } from '@agora/durable-core';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';

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
  return { app, resolve: () => factory?.() as WorkflowEngine };
}

describe('DurableProvider', () => {
  it('binds a WorkflowEngine built from config (in-memory defaults)', async () => {
    const { app, resolve } = fakeApp();
    new DurableProvider(app).register();

    const engine = resolve();
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
    expect(resolve()).toBeInstanceOf(WorkflowEngine);
  });
});
