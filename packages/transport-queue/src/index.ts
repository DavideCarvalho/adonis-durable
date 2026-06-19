/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

export { QueueTransport, type QueueTransportOptions } from './queue_transport.js';
export { createQueueTransport, defineConfig } from './define_config.js';
export {
  toJson,
  fromJson,
  type TaskPayload,
  type ResultPayload,
  type HeartbeatPayload,
  type ControlPayload,
} from './serialization.js';
