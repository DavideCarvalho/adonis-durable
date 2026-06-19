import { QueueTransport, type QueueTransportOptions } from './queue_transport.js';

/**
 * Factory for a {@link QueueTransport} to wire into `config/durable.ts`:
 *
 * ```ts
 * import { defineConfig } from '@agora/durable';
 * import { createQueueTransport } from '@agora/durable-transport-queue';
 * import { redis } from '@adonisjs/queue';
 *
 * export default defineConfig({
 *   transport: createQueueTransport({ adapter: redis({ host: '127.0.0.1' }), group: 'pipeline' }),
 * });
 * ```
 */
export function createQueueTransport(options: QueueTransportOptions): QueueTransport {
  return new QueueTransport(options);
}

/** Identity helper giving the options object full type-checking at the call site. */
export function defineConfig(options: QueueTransportOptions): QueueTransportOptions {
  return options;
}
