/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.10.0';

// --- engine + core primitives -----------------------------------------------
export * from './admission.js';
export * from './control-flow-signal.js';
export * from './duration.js';
export * from './engine.js';
export * from './entities.js';
export * from './errors.js';
export * from './event-accumulators.js';
export * from './interfaces.js';
export * from './protocol.js';
export * from './queue.js';
export * from './remote-workflow-executor.js';
export * from './tenant-group.js';
export {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  type StepRef,
  stepConfigOf,
  stepNameOf,
} from './step-name-symbol.js';
export * from './step-ref.js';
export * from './step-discovery.js';
export * from './codec-state-store.js';
export * from './diagnostics-bridge.js';
export * from './events.js';
export * from './metrics.js';
export * from './pollers.js';
export * from './scheduler.js';
export * from './search-attributes.js';
export * from './tokens.js';
export * from './workflow-ref.js';
export * from './workflow-discovery.js';
export {
  BaseWorkflow,
  type WorkflowDispatchOptions,
  type WorkflowEngineResolver,
  setWorkflowEngineResolver,
} from './base-workflow.js';
export { getCurrentWorkflowCtx, workflowAls } from './workflow-als.js';
export { InMemoryStateStore } from './testing/in-memory-state-store.js';
export { InMemoryTransport } from './testing/in-memory-transport.js';

// --- config-driven transport drivers ----------------------------------------
export { transports } from './transports/factory.js';
export type {
  TransportContext,
  TransportFactory,
  MemoryTransportConfig,
  EventEmitterTransportConfig,
  QueueTransportConfig,
  DbTransportConfig,
} from './transports/factory.js';
export {
  EventEmitterTransport,
  type EventEmitterTransportOptions,
} from './transports/event-emitter.js';
export { QueueTransport, type QueueTransportOptions } from './transports/queue.js';
export { DbTransport, type DbTransportOptions } from './transports/db.js';
export {
  TRANSPORT_TABLES,
  createDurableTransportTables,
  dropDurableTransportTables,
} from './transports/db-schema.js';

// --- config-driven state-store drivers --------------------------------------
export { stores } from './stores/factory.js';
export type { StoreContext, StoreFactory, LucidStoreConfig } from './stores/factory.js';
export { LucidStateStore, type LucidStateStoreOptions } from './stores/lucid.js';
export { DURABLE_TABLES, createDurableTables, dropDurableTables } from './stores/lucid-schema.js';

// --- config-driven control-plane drivers ------------------------------------
export { controlPlanes } from './control-planes/factory.js';
export type {
  ControlPlaneContext,
  ControlPlaneFactory,
  RedisControlPlaneConfig,
} from './control-planes/factory.js';
export {
  RedisControlPlane,
  type RedisControlPlaneOptions,
  type RedisPubSub,
} from './control-plane-redis/redis-control-plane.js';

// --- AdonisJS integration ---------------------------------------------------
export { defineConfig } from './define_config.js';
export type { DurableConfig } from './define_config.js';
