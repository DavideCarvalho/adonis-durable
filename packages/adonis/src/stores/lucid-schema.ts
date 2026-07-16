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
  bufferedEvents: 'durable_buffered_events',
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
 *
 * Pass `connectionName` to provision the tables on a dedicated Lucid connection — it must match the
 * connection the store reads/writes on, or `ensureSchema` would create the tables where the store
 * never looks. Omit it to use the `Database` default connection.
 */
export async function createDurableTables(db: Database, connectionName?: string): Promise<void> {
  // Knex's schema builder is stateful — operations chained on one instance run together. Take a FRESH
  // `db.connection(connectionName).schema` for every hasTable/createTable so each DDL statement executes
  // exactly once, all on the store's own connection.
  const conn = () => db.connection(connectionName).schema;

  if (!(await conn().hasTable(DURABLE_TABLES.runs))) {
    await conn().createTable(DURABLE_TABLES.runs, (table) => {
      table.string('id').primary();
      table.string('workflow').notNullable();
      table.string('workflow_version').notNullable();
      table.string('status').notNullable();
      table.string('namespace').notNullable().defaultTo('default');
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
      // Worker-pool partition: scopes the poll/recovery queries (namespace + status + createdAt).
      table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
    });
  } else {
    // Auto-migrate an older runs table by adding any columns introduced after its creation. Each is
    // applied independently so a table missing several catches up. Mirrors the in-place pattern other
    // adapters use; new columns are nullable / carry a DEFAULT so existing rows read back unchanged.
    if (!(await conn().hasColumn(DURABLE_TABLES.runs, 'priority'))) {
      // Nullable (no default) so existing rows read back as "unprioritised" and the FIFO path is unchanged.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.integer('priority');
      });
    }
    if (!(await conn().hasColumn(DURABLE_TABLES.runs, 'namespace'))) {
      // DEFAULT 'default' so every pre-namespace row reads back in the reserved 'default' partition —
      // byte-identical behavior for a single-pool deploy that adds the column.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.string('namespace').notNullable().defaultTo('default');
        table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
      });
    }
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
  } else if (!(await conn().hasColumn(DURABLE_TABLES.checkpoints, 'parallel_group'))) {
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
  } else if (!(await conn().hasColumn(DURABLE_TABLES.signalWaiters, 'parallel_group'))) {
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

  // Reliable (buffered) events: a publish that matched NO live waiter keeps ONE copy here, consumed
  // by the first future matching `waitForEvent`. Keyed by `name` (not token) since many waiters can
  // share a name with different `match` criteria; the caller-minted `id` is the PK so a claim targets
  // an exact row. `published_at` is epoch-ms (for oldest-first scan + optional TTL pruning).
  if (!(await conn().hasTable(DURABLE_TABLES.bufferedEvents))) {
    await conn().createTable(DURABLE_TABLES.bufferedEvents, (table) => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.text('payload');
      table.bigInteger('published_at').notNullable();
      table.index(['name', 'published_at'], 'durable_buffered_events_name_idx');
    });
  }
}

/** Drop every durable table (reverse FK order). Used by tests and migration `down`. */
export async function dropDurableTables(db: Database, connectionName?: string): Promise<void> {
  const conn = () => db.connection(connectionName).schema;
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedEvents);
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedSignals);
  await conn().dropTableIfExists(DURABLE_TABLES.signalWaiters);
  await conn().dropTableIfExists(DURABLE_TABLES.attributes);
  await conn().dropTableIfExists(DURABLE_TABLES.checkpoints);
  await conn().dropTableIfExists(DURABLE_TABLES.runs);
}
