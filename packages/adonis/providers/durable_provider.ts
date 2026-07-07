import { pathToFileURL } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import type { ControlPlaneContext } from '../src/control-planes/factory.js';
import type { DurableConfig } from '../src/define_config.js';
import {
  type ControlPlane,
  InMemoryStateStore,
  InMemoryTransport,
  type StateStore,
  type StepServer,
  type StepsBarrel,
  type StoreContext,
  type Transport,
  type TransportContext,
  WorkflowEngine,
  type WorkflowEngineDeps,
  type WorkflowsBarrel,
  attachDurableDiagnostics,
  registerStepsFromBarrel,
  registerStepsFromDir,
  registerWorkflowsFromBarrel,
  registerWorkflowsFromDir,
} from '../src/index.js';

/** The read view of `@adonis-agora/context`'s accessor, read structurally from its global slot. */
interface ContextAccessorLike {
  get(): Record<string, unknown> | undefined;
}
const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/**
 * Global slot `@adonis-agora/diagnostics-otel` publishes its `otelTraceparent` under: a
 * `() => string | undefined` returning the active OTel span's W3C `traceparent`.
 * Read structurally so durable continues the OpenTelemetry trace on remote steps
 * with zero config when OTel is installed — and no hard dependency when it is not.
 */
const OTEL_TRACEPARENT = Symbol.for('@agora/otel:traceparent');

/** `@adonis-agora/diagnostics`'s emit capability slot (set at that package's module load when installed). */
const DIAGNOSTICS_EMIT = Symbol.for('@agora/diagnostics:emit');

/**
 * Wires `@adonis-agora/durable` into the AdonisJS application: binds a singleton
 * {@link WorkflowEngine} built from `config/durable.ts`.
 *
 * Defaults to an in-process store + transport (single-process, zero infra). Pick a `transport` /
 * `store` by name from the config's `transports` / `stores` maps to run cross-process or persist
 * durably; each selected driver's peer dependency is imported lazily inside its factory thunk, only
 * when that driver is chosen. When `@adonis-agora/context` is installed, the originating
 * tenant/user/correlation carrier is attached to each dispatched task (best-effort, read structurally
 * from the global accessor slot — no hard dependency). When `@adonis-agora/diagnostics-otel` (and an OTel SDK
 * such as `@adonisjs/otel`) is installed, each dispatched task is stamped with the active OTel
 * `traceparent` so a worker continues the trace.
 *
 * ```ts
 * const engine = await app.container.make(WorkflowEngine)
 * engine.register('order', '1', async (ctx) => { ... })
 * await engine.start('order', input, runId)
 * ```
 */
export default class DurableProvider {
  #detachDiagnostics: (() => void) | null = null;
  #transport: (Transport & { close?: () => Promise<void> }) | null = null;
  #controlPlane: (ControlPlane & { close?: () => Promise<void> }) | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(WorkflowEngine, async () => {
      const config = this.app.config.get<DurableConfig>('durable', {});
      const accessor = (globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] as
        | ContextAccessorLike
        | undefined;
      const otelTraceparent = (globalThis as Record<symbol, unknown>)[OTEL_TRACEPARENT] as
        | (() => string | undefined)
        | undefined;

      const ctx: TransportContext & StoreContext & ControlPlaneContext = { app: this.app };
      const store = await this.#resolveStore(config, ctx);
      const transport = await this.#resolveTransport(config, ctx);
      // Hold the transport so `shutdown()` can release broker workers/connections cleanly.
      this.#transport = transport;
      const controlPlane = await this.#resolveControlPlane(config, ctx);
      // Hold the control plane so `shutdown()` can tear down its subscriber connection cleanly.
      this.#controlPlane = controlPlane;

      const deps: WorkflowEngineDeps = {
        store,
        transport,
        ...(controlPlane ? { controlPlane } : {}),
        ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
        ...(config.instanceId ? { instanceId: config.instanceId } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.maxRecoveryAttempts !== undefined
          ? { maxRecoveryAttempts: config.maxRecoveryAttempts }
          : {}),
        ...(config.compensationRetries !== undefined
          ? { compensationRetries: config.compensationRetries }
          : {}),
        ...(config.runDispatcher ? { runDispatcher: config.runDispatcher } : {}),
        // Best-effort context propagation from @adonis-agora/context (no hard dep): pass the opaque
        // carrier through verbatim. The carrier is producer-owned and shape-opaque; the worker's
        // scope slot round-trips the whole snapshot via Context.run, so no field-picking is needed.
        ...(accessor ? { context: () => accessor.get() } : {}),
        // Best-effort OTel trace continuation from @adonis-agora/diagnostics-otel (no hard dep).
        ...(otelTraceparent ? { traceparent: otelTraceparent } : {}),
      };

      return new WorkflowEngine(deps);
    });
  }

  /**
   * Auto-register the `app/workflows` convention so users never call `engine.register(...)` by hand
   * (mirrors `@adonisjs/queue`'s `app/jobs`). Opt-out with `config.workflowsPath = false`.
   *
   * Prefers the **build-time barrel** generated by the Assembler `init` hook
   * (`@adonis-agora/durable/hooks/workflows` → `.adonisjs/durable/workflows.js`): registering from it
   * avoids any runtime `readdir`. When that barrel is absent (the hook isn't registered in
   * `adonisrc.ts`, or it hasn't been generated yet) it FALLS BACK to the runtime directory scan, so
   * apps that don't opt into the hook keep working unchanged. The low-level
   * `engine.register(name, version, fn)` remains the escape hatch.
   */
  async boot() {
    const config = this.app.config.get<DurableConfig>('durable', {});
    if (config.workflowsPath === false) return;
    const engine = await this.app.container.make(WorkflowEngine);

    const barrel = await this.#loadGeneratedWorkflowsBarrel();
    if (barrel) {
      await registerWorkflowsFromBarrel(engine, barrel);
    } else {
      // Fallback: no generated barrel — scan the configured directory at runtime.
      const dir = this.app.makePath(config.workflowsPath ?? 'app/workflows');
      await registerWorkflowsFromDir(engine, dir);
    }

    await this.#registerSteps(config);
  }

  /**
   * Auto-register the `app/steps` convention: every `@Step` class / `defineStep(...)` handler is
   * served BY NAME on the app's transport, so `ctx.step('name', input)` (or a typed ref) routes to it
   * with no manual `transport.handle(...)`. Opt-out with `config.stepsPath = false`. Prefers the
   * build-time barrel (`@adonis-agora/durable/hooks/steps`), falling back to a runtime directory scan.
   * A transport that can't serve handlers (no `handle`) is skipped.
   */
  async #registerSteps(config: DurableConfig) {
    if (config.stepsPath === false) return;
    const server = this.#transport as (Transport & Partial<StepServer>) | null;
    if (!server || typeof server.handle !== 'function') return;
    const barrel = await this.#loadGeneratedStepsBarrel();
    if (barrel) {
      await registerStepsFromBarrel(server as StepServer, barrel);
      return;
    }
    const dir = this.app.makePath(config.stepsPath ?? 'app/steps');
    await registerStepsFromDir(server as StepServer, dir);
  }

  /** Best-effort import of the build-time steps barrel; `null` when absent (fall back to the scan). */
  async #loadGeneratedStepsBarrel(): Promise<StepsBarrel | null> {
    const path = this.app.makePath('.adonisjs/durable/steps.js');
    try {
      const mod = (await import(pathToFileURL(path).href)) as { steps?: StepsBarrel };
      return mod.steps ?? null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Best-effort import of the build-time workflows barrel the Assembler `init` hook generates. Returns
   * the barrel's `workflows` export when present, or `null` when the file doesn't exist (the hook
   * isn't registered) — the signal for `boot()` to fall back to the runtime scan. Only a genuine
   * "module not found" is swallowed; any other import error propagates (a broken generated barrel
   * should surface, not silently degrade).
   */
  async #loadGeneratedWorkflowsBarrel(): Promise<WorkflowsBarrel | null> {
    const path = this.app.makePath('.adonisjs/durable/workflows.js');
    try {
      const mod = (await import(pathToFileURL(path).href)) as { workflows?: WorkflowsBarrel };
      return mod.workflows ?? null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Resolve the configured state store (a key of `config.stores`), or the in-memory default. */
  async #resolveStore(config: DurableConfig, ctx: StoreContext): Promise<StateStore> {
    const name = config.store;
    if (!name) return new InMemoryStateStore();
    const factory = config.stores?.[name];
    if (!factory) {
      throw new Error(
        `@agora/durable: config.store is "${name}", but config.stores.${name} is not defined`,
      );
    }
    return factory(ctx);
  }

  /** Resolve the configured transport (a key of `config.transports`), or the in-memory default. */
  async #resolveTransport(config: DurableConfig, ctx: TransportContext): Promise<Transport> {
    const name = config.transport;
    if (!name) return new InMemoryTransport();
    const factory = config.transports?.[name];
    if (!factory) {
      throw new Error(
        `@agora/durable: config.transport is "${name}", but config.transports.${name} is not defined`,
      );
    }
    return factory(ctx);
  }

  /**
   * Resolve the configured control plane. `config.controlPlane` may be a ready {@link ControlPlane}
   * instance (used as-is) or a {@link ControlPlaneFactory} thunk (called at boot so its peer
   * dependency loads lazily). Omitted → no control plane (the engine runs local-only).
   */
  async #resolveControlPlane(
    config: DurableConfig,
    ctx: ControlPlaneContext,
  ): Promise<(ControlPlane & { close?: () => Promise<void> }) | null> {
    const cp = config.controlPlane;
    if (!cp) return null;
    return typeof cp === 'function' ? cp(ctx) : cp;
  }

  /**
   * Once everything is booted, bridge engine lifecycle events onto the `@adonis-agora/diagnostics` bus —
   * but only when diagnostics is actually installed (its emit slot is populated at module load).
   * Gating on the slot avoids eagerly constructing the engine when diagnostics is absent; when it is
   * present, this makes durable runs visible to `onDiagnostic`, Telescope, the relays and OTel with
   * zero config. No hard dependency on `@adonis-agora/diagnostics`.
   */
  async ready() {
    const emit = (globalThis as Record<symbol, unknown>)[DIAGNOSTICS_EMIT];
    if (typeof emit !== 'function') return;
    const engine = await this.app.container.make(WorkflowEngine);
    this.#detachDiagnostics = attachDurableDiagnostics(engine);
  }

  async shutdown() {
    this.#detachDiagnostics?.();
    this.#detachDiagnostics = null;
    // Release the transport's broker workers / queues / connections so a deploy hands off cleanly.
    await this.#transport?.close?.();
    this.#transport = null;
    // Tear down the control plane's subscriber connection (Redis pub/sub) on the way out.
    await this.#controlPlane?.close?.();
    this.#controlPlane = null;
  }
}
