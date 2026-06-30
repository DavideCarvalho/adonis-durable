import type { Database } from '@adonisjs/lucid/database';

/**
 * The canonical durable table names. They match the cross-adapter snake_case contract the other
 * Agora/aviary stores use (Drizzle is the reference), so a dashboard or migration can be pointed at
 * any adapter and see the same physical schema.
 */
export const DURABLE_TABLES = {
  runs: 'durable_workflow_runs',
  checkpoints: 'durable_step_checkpoints',
  attributes: 'durable_run_attributes',
  signalWaiters: 'durable_signal_waiters',
  bufferedSignals: 'durable_buffered_signals',
} as const;

/**
 * Idempotent DDL for the durable tables, expressed via Lucid's schema builder (Knex). Works across
 * SQLite / Postgres / MySQL. Timestamps and `wake_at` are stored as epoch-ms `bigInteger` columns so
 * the store never depends on a native date type and replay is exact across engines. JSON payloads
 * (`input`/`output`/`error`/`events`/`tags`/`search_attributes`) are stored as `text` and (de)serialized
 * by the store, so the schema is portable (SQLite has no JSON column type; Postgres/MySQL accept text).
 *
 * Call this on boot (e.g. from a `StateStore.ensureSchema`) or once at deploy time. For an AdonisJS app
 * prefer the published migration (`node ace configure @adonis-agora/durable`); this helper is for standalone
 * use, tests, and `ensureSchema`.
 */
export async function createDurableTables(db: Database): Promise<void> {
  // Knex's schema builder is stateful — operations chained on one instance run together. Take a FRESH
  // `db.connection().schema` for every hasTable/createTable so each DDL statement executes exactly once.
  const conn = () => db.connection().schema;

  if (!(await conn().hasTable(DURABLE_TABLES.runs))) {
    await conn().createTable(DURABLE_TABLES.runs, (table) => {
      table.string('id').primary();
      table.string('workflow').notNullable();
      table.string('workflow_version').notNullable();
      table.string('status').notNullable();
      table.text('input');
      table.text('output');
      table.text('error');
      table.bigInteger('wake_at');
      table.string('locked_by');
      table.bigInteger('locked_until');
      table.integer('recovery_attempts');
      table.text('tags');
      table.text('search_attributes');
      table.integer('priority');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.index(['status'], 'durable_runs_status_idx');
      table.index(['status', 'wake_at'], 'durable_runs_due_idx');
    });
  } else if (!(await db.connection().schema.hasColumn(DURABLE_TABLES.runs, 'priority'))) {
    // Auto-migrate an older runs table: add the nullable `priority` column in place. Nullable (no
    // default) so existing rows read back as "unprioritised" and the FIFO path is unchanged.
    await conn().alterTable(DURABLE_TABLES.runs, (table) => {
      table.integer('priority');
    });
  }

  if (!(await conn().hasTable(DURABLE_TABLES.checkpoints))) {
    await conn().createTable(DURABLE_TABLES.checkpoints, (table) => {
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('name').notNullable();
      table.string('kind').notNullable();
      table.string('step_id').notNullable();
      table.string('status').notNullable();
      table.text('input');
      table.text('output');
      table.text('error');
      table.text('events');
      table.integer('attempts').notNullable();
      table.string('worker_group');
      table.bigInteger('wake_at');
      table.string('parallel_group');
      table.bigInteger('enqueued_at');
      table.bigInteger('started_at').notNullable();
      table.bigInteger('finished_at').notNullable();
      table.primary(['run_id', 'seq']);
      table.index(['run_id', 'name'], 'durable_checkpoints_name_idx');
    });
  } else if (
    !(await db.connection().schema.hasColumn(DURABLE_TABLES.checkpoints, 'parallel_group'))
  ) {
    // Auto-migrate an older checkpoints table: add the nullable `parallel_group` column in place.
    // Nullable (no default) so a legacy (non-parallel) checkpoint reads back untagged.
    await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
      table.string('parallel_group');
    });
  }

  if (!(await conn().hasTable(DURABLE_TABLES.attributes))) {
    await conn().createTable(DURABLE_TABLES.attributes, (table) => {
      table.string('run_id').notNullable();
      table.string('key').notNullable();
      table.string('str_value');
      table.double('num_value');
      table.primary(['run_id', 'key']);
      table.index(['key', 'num_value'], 'durable_run_attributes_num_idx');
      table.index(['key', 'str_value'], 'durable_run_attributes_str_idx');
    });
  }

  if (!(await conn().hasTable(DURABLE_TABLES.signalWaiters))) {
    await conn().createTable(DURABLE_TABLES.signalWaiters, (table) => {
      table.string('token').primary();
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('parallel_group');
    });
  } else if (
    !(await db.connection().schema.hasColumn(DURABLE_TABLES.signalWaiters, 'parallel_group'))
  ) {
    // Auto-migrate an older signal_waiters table: add the nullable `parallel_group` column in place.
    // Nullable (no default) so a legacy (non-fan) waiter reads back untagged and the await is unchanged.
    await conn().alterTable(DURABLE_TABLES.signalWaiters, (table) => {
      table.string('parallel_group');
    });
  }

  if (!(await conn().hasTable(DURABLE_TABLES.bufferedSignals))) {
    await conn().createTable(DURABLE_TABLES.bufferedSignals, (table) => {
      table.increments('id').primary();
      table.string('token').notNullable();
      table.text('payload');
      table.index(['token'], 'durable_buffered_signals_token_idx');
    });
  }
}

/** Drop every durable table (reverse FK order). Used by tests and migration `down`. */
export async function dropDurableTables(db: Database): Promise<void> {
  const conn = () => db.connection().schema;
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedSignals);
  await conn().dropTableIfExists(DURABLE_TABLES.signalWaiters);
  await conn().dropTableIfExists(DURABLE_TABLES.attributes);
  await conn().dropTableIfExists(DURABLE_TABLES.checkpoints);
  await conn().dropTableIfExists(DURABLE_TABLES.runs);
}
