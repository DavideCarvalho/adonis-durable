/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

export { DbTransport, type DbTransportOptions } from './db_transport.js';
export { createDbTransport, defineConfig } from './define_config.js';
export {
  TRANSPORT_TABLES,
  createDurableTransportTables,
  dropDurableTransportTables,
} from './schema.js';
export {
  toJson,
  fromJson,
  type TaskPayload,
  type ResultPayload,
  type HeartbeatPayload,
  type ControlPayload,
} from './serialization.js';
