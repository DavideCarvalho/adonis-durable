import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @agora/durable` — registers the provider and publishes
 * `config/durable.ts`.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@agora/durable/durable_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/durable.stub', {});
}
