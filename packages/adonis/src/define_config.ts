import type {
  ControlPlaneConfig,
  StandaloneConfig,
  TenantConfig,
  TenantVerifier,
  VerifiedTenant,
} from './config_types.js';
import { controlPlanes } from './control-planes/factory.js';
import type {
  ControlPlaneContext,
  ControlPlaneFactory,
  RedisControlPlaneConfig,
} from './control-planes/factory.js';
import type { ControlPlane, RunDispatcher } from './interfaces.js';
import type { ScheduledWorkflow } from './scheduler.js';
import { stores } from './stores/factory.js';
import type { LucidStoreConfig, StoreContext, StoreFactory } from './stores/factory.js';
import { transports } from './transports/factory.js';
import type {
  DbTransportConfig,
  EventEmitterTransportConfig,
  MemoryTransportConfig,
  QueueTransportConfig,
  TransportContext,
  TransportFactory,
} from './transports/factory.js';

/**
 * The **shared** fields of `config/durable.ts`, common to every {@link DurableConfig} role. Everything
 * here is optional — by default the engine uses an in-process
 * state store + transport (single-process, no extra infra). Pick a `transport`/`store` by name from
 * the `transports`/`stores` maps to run cross-process or persist durably; build the entries with the
 * {@link transports} / {@link stores} factories so each peer dependency (`@adonisjs/queue`,
 * `@adonisjs/lucid`) is imported lazily, only when that driver is actually selected.
 *
 * ```ts
 * import { defineConfig, transports, stores } from '@adonis-agora/durable'
 * import { redis } from '@adonisjs/queue'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: {
 *     // production single-process, no external infra:
 *     'event-emitter': transports.eventEmitter(),
 *     queue: transports.queue({ adapter: redis({ host: '127.0.0.1' }), group: 'durable' }),
 *     db: transports.db({ connection: 'pg' }),
 *   },
 *   store: 'lucid',
 *   stores: {
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 */
export interface BaseDurableConfig {
  /**
   * Which topology this engine runs as (spec §3): `'standalone'` (default — control-plane + embedded
   * worker), `'control-plane'` (pure coordinator), or `'tenant'` (store-less thin pod). Selected
   * explicitly, never inferred. Omit it and {@link defineConfig} defaults to `'standalone'`, so a
   * config written before roles existed behaves identically. The concrete per-role shape is a member
   * of the {@link DurableConfig} union; this base only declares the discriminant for shared reads.
   */
  role?: 'standalone' | 'control-plane' | 'tenant';
  /**
   * Name of the transport (a key of {@link transports}) the engine dispatches over. Omit for the
   * in-process transport (single-process, no extra infra).
   */
  transport?: string;
  /** Named transports, built with the {@link transports} factory. */
  transports?: Record<string, TransportFactory>;
  /**
   * Name of the state store (a key of {@link stores}) for runs/checkpoints/timers. Omit for the
   * in-memory store (single-process).
   */
  store?: string;
  /** Named state stores, built with the {@link stores} factory. */
  stores?: Record<string, StoreFactory>;
  /**
   * Whether the provider provisions the selected store's schema at boot by calling its
   * `ensureSchema()` (idempotent `CREATE TABLE IF NOT EXISTS`). Default `true` — the lib manages its
   * own tables, matching the rest of the ecosystem (agent/authz/telescope). Set `false` to manage the
   * schema yourself via a migration (`createDurableTables(db, connection)`) — e.g. when the app's DB
   * user may not run DDL at boot, or you want explicit, reviewed schema changes. The in-memory store
   * has no schema, so this is a no-op for it.
   */
  autoSchema?: boolean;
  /**
   * Cross-instance broadcast for lifecycle events + cancellation. Omit for single-instance. Either a
   * ready {@link ControlPlane} instance, or a {@link ControlPlaneFactory} built with the
   * {@link controlPlanes} factory (e.g. `controlPlanes.redis({ connection: 'main' })`) so the peer
   * dependency (`@adonisjs/redis`) is imported lazily, only when selected.
   */
  controlPlane?: ControlPlane | ControlPlaneFactory;
  /** Recovery lease duration in ms. Default 30s. */
  leaseMs?: number;
  /** Unique id for this engine instance. Defaults to a random id. */
  instanceId?: string;
  /**
   * Worker-pool partition for this engine. Stamped on every run it creates; the poll/recovery paths
   * only act on runs in this namespace, and a non-`'default'` namespace also segments the transport's
   * queue names. Default `'default'` — byte-identical to a single-pool deployment. Set distinct values
   * to safely share ONE state store + broker across non-interchangeable pools (e.g. local dev vs a cluster).
   */
  namespace?: string;
  /** Cap crash-recovery pickups before dead-lettering a poison run. Omit for unlimited. */
  maxRecoveryAttempts?: number;
  /** Attempts per saga compensation on run failure. Default 1. */
  compensationRetries?: number;
  /** Where a freshly-started run executes. Defaults to in-process (microtask). */
  runDispatcher?: RunDispatcher;
  /**
   * Recurring workflows to start on a schedule (fixed interval via `everyMs`, or cron via `cron` +
   * `timezone`). The `durable:work` worker loop fires any due windows on every tick (the 5th phase,
   * after timeouts are swept). `engine.start` is idempotent by each schedule's time-bucket run id, so
   * racing worker instances start every window **exactly once**. Cron schedules need the optional
   * `cron-parser` peer dependency. Omit (or leave empty) to register no schedules.
   */
  schedules?: ScheduledWorkflow[];
  /**
   * Directory (relative to the app root) the provider scans at boot for workflow classes
   * (`BaseWorkflow` subclasses) to auto-register on the engine — the
   * `app/workflows` convention, mirroring `@adonisjs/queue`'s
   * `app/jobs`. Default `'app/workflows'`. Set `false` to disable discovery entirely (register by
   * hand with `engine.register(...)`). A missing directory is fine — nothing to register.
   */
  workflowsPath?: string | false;
  /**
   * Directory (relative to the app root) the provider scans at boot for `@Step`-decorated classes and
   * `defineStep(...)` handlers to auto-register on the app's transport — the `app/steps` convention,
   * mirroring `app/workflows`. Each discovered handler is served by name so `ctx.step('name', input)`
   * (or a typed ref) routes to it with zero manual `transport.handle(...)`. Default `'app/steps'`. Set
   * `false` to disable (register by hand). A missing directory is fine — nothing to register.
   */
  stepsPath?: string | false;
}

/**
 * Shape of `config/durable.ts` — a **role-discriminated union** (spec §5). TypeScript narrows the
 * accepted config on the `role` literal, so each topology gets exactly the right fields and an
 * invalid combination is a compile error. The headline invariant: a `tenant` config may not name a
 * store (`store?: never` on {@link TenantConfig}), making store-less isolation a compile-time fact.
 * A config with no `role` lands on {@link StandaloneConfig} — the default — preserving the
 * pre-roles config byte-for-byte.
 */
export type DurableConfig = StandaloneConfig | ControlPlaneConfig | TenantConfig;

/**
 * Identity helper giving `config/durable.ts` full type-checking. Overloaded so the return type
 * **narrows on `role`**: pass a `tenant` config and you get a {@link TenantConfig} back, etc. The
 * `role` is defaulted to `'standalone'` at runtime, so a config that omits it (every config written
 * before roles existed) still boots as the single-process standalone engine.
 */
export function defineConfig(config: TenantConfig): TenantConfig;
export function defineConfig(config: ControlPlaneConfig): ControlPlaneConfig;
export function defineConfig(config?: StandaloneConfig): StandaloneConfig;
export function defineConfig(config: DurableConfig = { role: 'standalone' }): DurableConfig {
  // Default the discriminant so downstream (provider, gateway) can branch on a always-present `role`
  // without re-deriving it. `...config` wins, so an explicit role is preserved.
  return { role: 'standalone', ...config } as DurableConfig;
}

export { transports, stores, controlPlanes };
export type {
  StandaloneConfig,
  ControlPlaneConfig,
  TenantConfig,
  TenantVerifier,
  VerifiedTenant,
  TransportContext,
  TransportFactory,
  MemoryTransportConfig,
  EventEmitterTransportConfig,
  QueueTransportConfig,
  DbTransportConfig,
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  ControlPlaneContext,
  ControlPlaneFactory,
  RedisControlPlaneConfig,
};
