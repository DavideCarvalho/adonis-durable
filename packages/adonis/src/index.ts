/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

// --- engine + core primitives -----------------------------------------------
export * from './admission.js';
export * from './duration.js';
export * from './engine.js';
export * from './entities.js';
export * from './errors.js';
export * from './event-accumulators.js';
export * from './interfaces.js';
export * from './protocol.js';
export * from './queue.js';
export * from './remote-step-factory.js';
export * from './remote-workflow-executor.js';
export * from './codec-state-store.js';
export * from './diagnostics-bridge.js';
export * from './events.js';
export * from './metrics.js';
export * from './pollers.js';
export * from './scheduler.js';
export * from './search-attributes.js';
export * from './tokens.js';
export * from './workflow-ref.js';
export { InMemoryStateStore } from './testing/in-memory-state-store.js';
export { InMemoryTransport } from './testing/in-memory-transport.js';

// --- config-driven transport drivers ----------------------------------------
export { transports } from './transports/factory.js';
export type {
  TransportContext,
  TransportFactory,
  MemoryTransportConfig,
  QueueTransportConfig,
  DbTransportConfig,
} from './transports/factory.js';
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

// --- AdonisJS integration ---------------------------------------------------
export { defineConfig } from './define_config.js';
export type { DurableConfig } from './define_config.js';
