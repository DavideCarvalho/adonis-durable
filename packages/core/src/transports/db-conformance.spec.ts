import { assertTransportConformance } from '@agora/durable-testing';
import { describe, it } from 'vitest';
import { DbTransport } from './db.js';
import { makeMemoryDb } from './db-helpers.js';

/**
 * Run the shared Transport contract against the DB-table-backed transport (one instance acting as
 * both engine and worker over an in-memory SQLite), proving a remote step round-trips through rows to
 * a worker and back and that a throwing handler surfaces as a failed run — identical to every other
 * transport. The transport auto-creates its own tables; `assertTransportConformance` stops its
 * pollers, then we close the db.
 */
describe('DbTransport conformance', () => {
  it('satisfies the shared Transport contract', async () => {
    const db = makeMemoryDb();
    const transport = new DbTransport({ db, group: 'conformance', pollIntervalMs: 5 });
    await assertTransportConformance(transport);
    await db.manager.closeAll();
  });
});
