import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { type RunStatus, WorkflowEngine } from '@agora/durable-core';
import { listRuns, renderRunsTable } from '../src/runs.js';

/**
 * `node ace durable:runs` — list recent workflow runs, optionally filtered by status and workflow.
 * Reads through the engine's read API (`engine.listRuns`); for the listing to show runs across
 * processes the engine must be backed by a persistent store (config/durable.ts).
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
    const engine = await this.app.container.make(WorkflowEngine);
    const runs = await listRuns(engine, {
      ...(this.status ? { status: this.status as RunStatus } : {}),
      ...(this.workflow ? { workflow: this.workflow } : {}),
      limit: this.limit,
    });
    this.logger.log(renderRunsTable(runs));
  }
}
