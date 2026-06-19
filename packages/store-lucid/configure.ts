import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/durable-store-lucid` — publishes the durable-tables migration into the
 * app's `database/migrations`. Run `node ace migration:run` afterwards, then wire the store in
 * `config/durable.ts`:
 *
 * ```ts
 * import db from '@adonisjs/lucid/services/db'
 * import { lucidStateStore } from '@agora/durable-store-lucid'
 * export default defineConfig({ store: lucidStateStore(db) })
 * ```
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_durable_tables.stub', {});
}
