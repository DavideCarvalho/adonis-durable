import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/durable-dashboard` — registers the provider and
 * publishes `config/durable_dashboard.ts`.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/durable-dashboard/dashboard_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/durable_dashboard.stub', {});
}
