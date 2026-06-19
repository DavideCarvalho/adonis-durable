/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

export {
  LucidStateStore,
  type LucidStateStoreOptions,
  lucidStateStore,
} from './lucid-state-store.js';
export { createDurableTables, dropDurableTables, DURABLE_TABLES } from './schema.js';
