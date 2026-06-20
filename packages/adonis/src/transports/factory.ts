import type { AdapterFactory } from '@adonisjs/queue/types';
import type { ControlPlane, Transport } from '../interfaces.js';
import { InMemoryTransport } from '../testing/in-memory-transport.js';

/**
 * The minimal application surface a {@link TransportFactory} thunk needs at boot to resolve an
 * optional peer's service (the Lucid `db`, the queue adapter, etc.). The durable provider passes the
 * booted `ApplicationService`, which satisfies this structurally — typed here so core stays free of a
 * hard `@adonisjs/core` dependency.
 */
export interface TransportContext {
  /** The booted application — used to resolve services/connections from the container. */
  app: {
    container: { make(service: unknown): Promise<unknown> };
    config: { get<T>(key: string, defaultValue?: T): T };
  };
}

/**
 * A configured transport: a thunk the durable provider calls at boot to build the {@link Transport}
 * (often also a {@link ControlPlane}). Each factory lazily imports its peer dependency
 * (`@adonisjs/queue`, `@adonisjs/lucid`) inside the thunk, so the driver is only loaded when it is
 * actually selected — keeping those packages optional.
 */
export type TransportFactory = (
  ctx: TransportContext,
) => Promise<Transport & Partial<ControlPlane>>;

/** Options for the in-memory transport (no peer dependency). */
export interface MemoryTransportConfig {
  /* no options — in-process transport */
}

/** Options for the `@adonisjs/queue` transport. */
export interface QueueTransportConfig {
  /**
   * Name of the `@adonisjs/queue` connection — a key of the `adapters` map in `config/queue.ts` —
   * whose adapter this transport reads/writes. Omit to use that file's `default` connection. You
   * configure the driver and its host/credentials once in `config/queue.ts`; durable just references
   * it by name, exactly like `stores.lucid({ connection })` or `stores.redis({ connection })`.
   */
  connection?: string;
  /**
   * Escape hatch: pass a raw `@adonisjs/queue` adapter factory directly (e.g. `redis(...)`) instead of
   * resolving one from `config/queue.ts`. For non-Adonis setups or a bespoke adapter. Takes
   * precedence over `connection`.
   */
  adapter?: AdapterFactory;
  /** Worker group this instance serves (required on a worker process to register handlers). */
  group?: string;
  /** Queue-name prefix so several apps can share one backend without colliding. Default `durable`. */
  prefix?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** Stable id for this process (stamped on heartbeats / control `from`). Default a random id. */
  instanceId?: string;
}

/** Options for the DB-table-backed (`@adonisjs/lucid`) transport. */
export interface DbTransportConfig {
  /** Worker group this instance serves (required on a worker process to register handlers). */
  group?: string;
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** How long a claimed-but-unfinished row is owned before it's reclaimable (crash recovery). Default 30s. */
  leaseMs?: number;
  /** Max rows claimed per poll. Default 20. */
  batchSize?: number;
  /** Create the transport tables on first use if missing. Default true. */
  autoCreate?: boolean;
  /** Stable id for this process (stamped on heartbeats / control `from` / `claimed_by`). Default random. */
  instanceId?: string;
}

/**
 * The transport factory namespace used in `config/durable.ts`:
 *
 * ```ts
 * import { defineConfig, transports } from '@agora/durable'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: {
 *     memory: transports.memory(),
 *     queue: transports.queue({ connection: 'redis', group: 'durable' }),
 *     db: transports.db({ connection: 'pg' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link TransportFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is only imported when the provider builds the selected transport at
 * boot.
 */
/** A `config/queue.ts` `adapters` entry: a raw adapter factory or an AdonisJS config provider. */
type QueueAdapterEntry =
  | AdapterFactory
  | { resolver: (app: unknown) => AdapterFactory | Promise<AdapterFactory> };

/**
 * Resolve a raw `@adonisjs/queue` adapter factory from `config/queue.ts` by connection name —
 * mirroring `@adonisjs/queue`'s own `resolveAdapters`: a function entry is the factory; a config
 * provider is resolved via its `resolver(app)`. Reads only the app config, so it pulls in no
 * `@adonisjs/queue` runtime code.
 */
async function resolveQueueAdapter(
  ctx: TransportContext,
  connection?: string,
): Promise<AdapterFactory> {
  const queueConfig = ctx.app.config.get<{
    default?: string;
    adapters?: Record<string, QueueAdapterEntry>;
  }>('queue', { adapters: {} });

  const name = connection ?? queueConfig.default;
  if (!name) {
    throw new Error(
      '@agora/durable: transports.queue() needs a `connection`, or a `default` in config/queue.ts',
    );
  }
  const entry = queueConfig.adapters?.[name];
  if (!entry) {
    throw new Error(
      `@agora/durable: unknown @adonisjs/queue connection "${name}" — check the adapters in config/queue.ts`,
    );
  }
  return typeof entry === 'function' ? entry : entry.resolver(ctx.app);
}

export const transports = {
  /** In-process transport + control plane (single-process, no extra infra). The default. */
  memory(_config: MemoryTransportConfig = {}): TransportFactory {
    return async () => new InMemoryTransport();
  },

  /** Run remote steps cross-process over `@adonisjs/queue`, using a connection from `config/queue.ts`. */
  queue(config: QueueTransportConfig = {}): TransportFactory {
    return async (ctx) => {
      const { QueueTransport } = await import('./queue.js');
      const adapter = config.adapter ?? (await resolveQueueAdapter(ctx, config.connection));
      return new QueueTransport({
        adapter,
        ...(config.group !== undefined ? { group: config.group } : {}),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      });
    };
  },

  /** Run remote steps cross-process over the app's database, using `@adonisjs/lucid` — no broker. */
  db(config: DbTransportConfig = {}): TransportFactory {
    return async () => {
      const db = (await import('@adonisjs/lucid/services/db')).default;
      const { DbTransport } = await import('./db.js');
      return new DbTransport({
        db,
        ...(config.group !== undefined ? { group: config.group } : {}),
        ...(config.connection !== undefined ? { connectionName: config.connection } : {}),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
        ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
        ...(config.batchSize !== undefined ? { batchSize: config.batchSize } : {}),
        ...(config.autoCreate !== undefined ? { autoCreate: config.autoCreate } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      });
    };
  },
};
