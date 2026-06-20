import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/durable` — auto-wires the package:
 *
 * 1. registers the core service provider in `adonisrc.ts`;
 * 2. registers the ace commands barrel (`durable:work`, `durable:runs`,
 *    `durable:retry`);
 * 3. registers the optional dashboard provider;
 * 4. publishes `config/durable.ts` + `config/durable_dashboard.ts`;
 * 5. publishes the Lucid migrations for the optional `lucid` store and `db`
 *    transport drivers (run `node ace migration:run`, and delete the transport
 *    migration if you don't use the `db` transport).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/durable/durable_provider');
    rcFile.addProvider('@agora/durable/dashboard_provider');
    rcFile.addCommand('@agora/durable/commands');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/durable.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'config/durable_dashboard.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_durable_tables.stub', {});
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_durable_transport_tables.stub',
    {},
  );
}
