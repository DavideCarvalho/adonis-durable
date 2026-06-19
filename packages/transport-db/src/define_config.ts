import { DbTransport, type DbTransportOptions } from './db_transport.js';

/**
 * Factory for a {@link DbTransport} to wire into `config/durable.ts`:
 *
 * ```ts
 * import db from '@adonisjs/lucid/services/db';
 * import { defineConfig } from '@agora/durable';
 * import { createDbTransport } from '@agora/durable-transport-db';
 *
 * export default defineConfig({
 *   // engine side (dispatches + consumes results); a worker process passes `group`
 *   transport: createDbTransport({ db }),
 * });
 * ```
 */
export function createDbTransport(options: DbTransportOptions): DbTransport {
  return new DbTransport(options);
}

/** Identity helper giving the options object full type-checking at the call site. */
export function defineConfig(options: DbTransportOptions): DbTransportOptions {
  return options;
}
