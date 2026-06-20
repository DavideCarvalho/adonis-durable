import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/durable` — registers the provider and publishes
 * `config/durable.ts`, plus the Lucid migrations for the optional `lucid` store
 * and `db` transport drivers (run `node ace migration:run`, and delete the
 * transport migration if you don't use the `db` transport).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/durable/durable_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/durable.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_durable_tables.stub', {});
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_durable_transport_tables.stub',
    {},
  );
}
