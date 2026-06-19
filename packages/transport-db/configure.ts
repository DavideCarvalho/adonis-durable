import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/durable-transport-db` — publishes the transport-tables migration into
 * the app's `database/migrations`. Run `node ace migration:run` afterwards, then wire the transport
 * in `config/durable.ts`:
 *
 * ```ts
 * import db from '@adonisjs/lucid/services/db'
 * import { createDbTransport } from '@agora/durable-transport-db'
 * export default defineConfig({ transport: createDbTransport({ db }) })
 * ```
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_durable_transport_tables.stub',
    {},
  );
}
