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
 * Wires `@agora/durable` into the AdonisJS application: binds a singleton
 * {@link WorkflowEngine} built from `config/durable.ts`.
 *
 * Defaults to an in-process store + transport (single-process, zero infra). When
 * `@agora/context` is installed, the originating tenant/user/correlation carrier
 * is attached to each dispatched task (best-effort, read structurally from the
 * global accessor slot — no hard dependency).
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
      };

      return new WorkflowEngine(deps);
    });
  }
}
