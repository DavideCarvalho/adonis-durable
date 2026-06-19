import type { ApplicationService } from '@adonisjs/core/types';
import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
  type WorkflowEngineDeps,
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

/**
 * Wires `@agora/durable` into the AdonisJS application: binds a singleton
 * {@link WorkflowEngine} built from `config/durable.ts`.
 *
 * Defaults to an in-process store + transport (single-process, zero infra). When
 * `@agora/context` is installed, the originating tenant/user/correlation carrier
 * is attached to each dispatched task (best-effort, read structurally from the
 * global accessor slot — no hard dependency). When `@agora/diagnostics-otel` (and
 * an OTel SDK such as `@adonisjs/otel`) is installed, each dispatched task is
 * stamped with the active OTel `traceparent` so a worker continues the trace.
 *
 * ```ts
 * const engine = await app.container.make(WorkflowEngine)
 * engine.register('order', '1', async (ctx) => { ... })
 * await engine.start('order', input, runId)
 * ```
 */
export default class DurableProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(WorkflowEngine, () => {
      const config = this.app.config.get<DurableConfig>('durable', {});
      const accessor = (globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] as
        | ContextAccessorLike
        | undefined;
      const otelTraceparent = (globalThis as Record<symbol, unknown>)[OTEL_TRACEPARENT] as
        | (() => string | undefined)
        | undefined;

      const deps: WorkflowEngineDeps = {
        store: config.store ?? new InMemoryStateStore(),
        transport: config.transport ?? new InMemoryTransport(),
        ...(config.transports ? { transports: config.transports } : {}),
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
}
