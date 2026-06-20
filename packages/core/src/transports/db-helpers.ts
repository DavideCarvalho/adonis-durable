import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { createDurableTransportTables } from './db-schema.js';

/**
 * Build a standalone Lucid `Database` over an in-memory SQLite (`better-sqlite3`) — the "using Lucid
 * outside an app" pattern. We construct `Database(config, logger, emitter)` directly (the three args
 * Lucid's provider passes) so the transport runs against real SQL with no AdonisJS app boot.
 */
export function makeMemoryDb(): Database {
  const logger = new Logger({ enabled: false });
  const emitter = new Emitter(undefined as never);
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          // A `:memory:` SQLite db is per-connection: pin the pool to ONE connection so every query
          // (and the schema) hits the same in-memory database.
          pool: { min: 1, max: 1 },
        },
      },
    },
    logger,
    emitter,
  );
}

/** A fresh in-memory db with the transport tables already created. */
export async function makeTransportDb(): Promise<Database> {
  const db = makeMemoryDb();
  await createDurableTransportTables(db);
  return db;
}
