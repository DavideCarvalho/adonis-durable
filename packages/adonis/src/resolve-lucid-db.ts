import type { TransportContext } from './transports/factory.js';

/**
 * The slice of Lucid's `Database` the durable Lucid store and db transport need: the `connection`
 * accessor. Typed structurally so this module never imports `@adonisjs/lucid` — keeping that peer
 * lazy (only the selected driver's thunk imports it).
 */
export interface LucidDatabaseLike {
  connection(connectionName?: string): unknown;
}

/**
 * Resolve the Lucid `Database` from the IoC container (the `'lucid.db'` binding) rather than from
 * `@adonisjs/lucid/services/db`'s default export.
 *
 * The durable provider builds the store and transport thunks during its OWN `boot()` — it resolves
 * the `WorkflowEngine` singleton there, which runs the selected thunks. But `services/db` only
 * assigns its default export inside `app.booted()`, which runs AFTER every provider's `boot()`, so at
 * thunk time that default is still `undefined` and dereferencing it (`db.connection(...)`) throws,
 * failing the whole app boot. The `'lucid.db'` alias is registered in the database provider's
 * `register()` (which runs before any `boot()`) and is the exact binding `services/db` itself
 * resolves once booted — so resolving through it works during boot and at runtime alike.
 */
export async function resolveLucidDatabase(ctx: TransportContext): Promise<LucidDatabaseLike> {
  return (await ctx.app.container.make('lucid.db')) as LucidDatabaseLike;
}
