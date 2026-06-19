import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { RunStatus } from '@agora/durable-core';
import { resolveStore } from '../src/resolve_store.js';
import { listRuns, renderRunsTable } from '../src/runs.js';

/**
 * `node ace durable:runs` — list recent workflow runs from the configured store, optionally filtered
 * by status and workflow. Reads the same store `config/durable.ts` hands the engine.
 */
export default class DurableRuns extends BaseCommand {
  static override commandName = 'durable:runs';
  static override description = 'List recent durable workflow runs';
  static override options: CommandOptions = { startApp: true };

  @flags.string({
    description: 'Filter by status (pending|running|suspended|completed|failed|cancelled|dead)',
  })
  declare status?: string;

  @flags.string({ description: 'Filter by workflow name' })
  declare workflow?: string;

  @flags.number({ description: 'Max runs to list', default: 50 })
  declare limit: number;

  override async run(): Promise<void> {
    const store = resolveStore(this.app);
    if (!store) {
      this.logger.error(
        'No store configured in config/durable.ts — listing runs needs a persistent store.',
      );
      this.exitCode = 1;
      return;
    }

    const runs = await listRuns(store, {
      ...(this.status ? { status: this.status as RunStatus } : {}),
      ...(this.workflow ? { workflow: this.workflow } : {}),
      limit: this.limit,
    });
    this.logger.log(renderRunsTable(runs));
  }
}
