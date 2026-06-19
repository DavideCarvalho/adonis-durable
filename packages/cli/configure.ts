import type Configure from '@adonisjs/core/commands/configure';

/**
 * `node ace configure @agora/durable-cli` — registers the durable commands barrel in the app's
 * `adonisrc`, so `durable:work`, `durable:runs`, and `durable:retry` become available to ace.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addCommand('@agora/durable-cli/commands');
  });
}
