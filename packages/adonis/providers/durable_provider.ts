import type { ApplicationService } from '@adonisjs/core/types';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type StateStore,
  type StoreContext,
  type Transport,
  type TransportContext,
  WorkflowEngine,
  type WorkflowEngineDeps,
  attachDurableDiagnostics,
} from '@agora/durable-core';
import type { DurableConfig } from '../src/define_config.js';

/** The read view of `@agora/context`'s accessor, read structurally from its global slot. */
interface ContextAccessorLike {
  traceId(): string | undefined;
  get(): Record<string, unknown> | undefined;
}
const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/**
 * Global slot `@agora/diagnostics-otel` publishes its `otelTraceparent` under: a
 * `() => string | undefined` returning the active OTel span's W3C `traceparent`.
 * Read structurally so durable continues the OpenTelemetry trace on remote steps
 * with zero config when OTel is installed — and no hard dependency when it is not.
 */
const OTEL_TRACEPARENT = Symbol.for('@agora/otel:traceparent');

/** `@agora/diagnostics`'s emit capability slot (set at that package's module load when installed). */
const DIAGNOSTICS_EMIT = Symbol.for('@agora/diagnostics:emit');

/**
 * Wires `@agora/durable` into the AdonisJS application: binds a singleton
 * {@link WorkflowEngine} built from `config/durable.ts`.
 *
 * Defaults to an in-process store + transport (single-process, zero infra). Pick a `transport` /
 * `store` by name from the config's `transports` / `stores` maps to run cross-process or persist
 * durably; each selected driver's peer dependency is imported lazily inside its factory thunk, only
 * when that driver is chosen. When `@agora/context` is installed, the originating
 * tenant/user/correlation carrier is attached to each dispatched task (best-effort, read structurally
 * from the global accessor slot — no hard dependency). When `@agora/diagnostics-otel` (and an OTel SDK
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

      const ctx: TransportContext & StoreContext = { app: this.app };
      const store = await this.#resolveStore(config, ctx);
      const transport = await this.#resolveTransport(config, ctx);
      // Hold the transport so `shutdown()` can release broker workers/connections cleanly.
      this.#transport = transport;

      const deps: WorkflowEngineDeps = {
        store,
        transport,
        ...(config.controlPlane ? { controlPlane: config.controlPlane } : {}),
        ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
        ...(config.instanceId ? { instanceId: config.instanceId } : {}),
        ...(config.maxRecoveryAttempts !== undefined
          ? { maxRecoveryAttempts: config.maxRecoveryAttempts }
          : {}),
        ...(config.compensationRetries !== undefined
          ? { compensationRetries: config.compensationRetries }
          : {}),
        ...(config.runDispatcher ? { runDispatcher: config.runDispatcher } : {}),
        // Best-effort context propagation from @agora/context (no hard dep).
        ...(accessor ? { context: () => accessor.get() } : {}),
        // Best-effort OTel trace continuation from @agora/diagnostics-otel (no hard dep).
        ...(otelTraceparent ? { traceparent: otelTraceparent } : {}),
      };

      return new WorkflowEngine(deps);
    });
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
   * Once everything is booted, bridge engine lifecycle events onto the `@agora/diagnostics` bus —
   * but only when diagnostics is actually installed (its emit slot is populated at module load).
   * Gating on the slot avoids eagerly constructing the engine when diagnostics is absent; when it is
   * present, this makes durable runs visible to `onDiagnostic`, Telescope, the relays and OTel with
   * zero config. No hard dependency on `@agora/diagnostics`.
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
  }
}
