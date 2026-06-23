import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Minimal Adonis container/app stand-in capturing the singleton factory. */
function fakeApp(config: DurableConfig = {}, appRoot = '/app') {
  let factory: (() => unknown) | undefined;
  let singletonInstance: unknown;
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    makePath: (...parts: string[]) => join(appRoot, ...parts),
    container: {
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
      make: async () => {
        if (!singletonInstance) singletonInstance = await factory?.();
        return singletonInstance as WorkflowEngine;
      },
    },
  } as unknown as ApplicationService;
  return { app, resolve: async () => (await app.container.make(WorkflowEngine)) as WorkflowEngine };
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

  it('passes the @agora/context carrier through verbatim (opaque, no field-picking)', async () => {
    const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');
    const g = globalThis as Record<symbol, unknown>;
    const carrier = { correlationId: 'corr-1', userRef: 'user-7', tenantId: 'acme' };
    g[CONTEXT_ACCESSOR] = { get: () => carrier };
    try {
      const { app, resolve } = fakeApp();
      new DurableProvider(app).register();
      const engine = await resolve();
      // Reach the engine's context thunk via the same path dispatch uses.
      const ctxThunk = (engine as unknown as { context?: () => Record<string, unknown> }).context;
      // The carrier is opaque: whatever the accessor returns rides the task unchanged.
      expect(ctxThunk?.()).toBe(carrier);
    } finally {
      delete g[CONTEXT_ACCESSOR];
    }
  });
});

describe('DurableProvider — app/workflows auto-discovery (boot)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'durable-prov-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('scans the configured dir and auto-registers @Workflow classes (no manual register)', async () => {
    await writeFile(
      join(dir, 'order_workflow.ts'),
      `import { Workflow } from '${SRC}/workflow-ref.js'
       class OrderWorkflow {
         async run(_ctx, input) { return 'order:' + input.id }
       }
       export default Workflow({ name: 'order', version: '1' })(OrderWorkflow)`,
    );

    // workflowsPath is given as a path relative to the (faked) app root === dir.
    const { app, resolve } = fakeApp({ workflowsPath: '.' }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    const engine = await resolve();
    await engine.start('order', { id: 'abc' }, 'o1');
    const result = await engine.waitForRun('o1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('order:abc');
  });

  it('skips discovery when workflowsPath is false', async () => {
    const { app } = fakeApp({ workflowsPath: false }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await expect(provider.boot()).resolves.toBeUndefined();
  });
});
