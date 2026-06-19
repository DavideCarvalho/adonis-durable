import type {
  ControlPlane,
  NamedTransport,
  RunDispatcher,
  StateStore,
  Transport,
} from '@agora/durable-core';

/**
 * Shape of `config/durable.ts`. Everything is optional — by default the engine
 * uses an in-process state store + transport (single-process, no extra infra).
 * Supply a persistent {@link StateStore} and a broker-backed {@link Transport}
 * for production / multi-process.
 */
export interface DurableConfig {
  /** Persistence for runs/checkpoints/timers. Defaults to in-memory (single-process). */
  store?: StateStore;
  /** Single task transport. Defaults to in-memory (single-process). */
  transport?: Transport;
  /** Ordered transport pool with failover (use instead of `transport`). */
  transports?: NamedTransport[];
  /** Cross-instance broadcast for lifecycle events + cancellation. Omit for single-instance. */
  controlPlane?: ControlPlane;
  /** Recovery lease duration in ms. Default 30s. */
  leaseMs?: number;
  /** Unique id for this engine instance. Defaults to a random id. */
  instanceId?: string;
  /** Cap crash-recovery pickups before dead-lettering a poison run. Omit for unlimited. */
  maxRecoveryAttempts?: number;
  /** Attempts per saga compensation on run failure. Default 1. */
  compensationRetries?: number;
  /** Where a freshly-started run executes. Defaults to in-process (microtask). */
  runDispatcher?: RunDispatcher;
}

/** Identity helper giving `config/durable.ts` full type-checking. */
export function defineConfig(config: DurableConfig = {}): DurableConfig {
  return config;
}
