import type { HeartbeatStatus, WorkerDescriptor } from '../handshake/descriptor.js';

/**
 * The advertisement side of the store-less worker handshake (design §7.2): a thin writer the
 * {@link import('./worker-runtime.js').WorkerRuntime} pushes its descriptor + compact heartbeat
 * through. Kept behind this interface so the runtime is transport-AND-backend agnostic — a test proves
 * advertisement against a fake, a real pod passes a {@link RedisWorkerRegistry}, and the runtime itself
 * imports no Redis client (keeping the worker subpath lean).
 */
export interface WorkerRegistry {
  /**
   * Publish the FULL {@link WorkerDescriptor} for a routing token+instance (the `${P}-worker-descriptor`
   * key). Re-called when the descriptor changes (new handler registered) and periodically to refresh
   * its TTL. The `ttlSeconds` self-expires the key when the worker dies without a clean stop.
   */
  advertiseDescriptor(ad: {
    key: string;
    descriptor: WorkerDescriptor;
    ttlSeconds: number;
  }): Promise<void>;
  /**
   * Beat the compact two-tier heartbeat `{ ts, status, descriptorHash }` for a routing token+instance
   * (the `${P}-worker-heartbeat` key), TTL'd so its absence is the "worker gone" signal. The
   * `descriptorHash` is the ETag a control-plane watches to know when to re-read the full descriptor.
   */
  beat(beat: { key: string; status: HeartbeatStatus; ttlSeconds: number }): Promise<void>;
  /** Best-effort removal of this instance's keys on a clean stop (a graceful drain). Optional. */
  remove?(keys: string[]): Promise<void>;
  /** Release any owned connection on stop. Optional. */
  close?(): Promise<void>;
}

/**
 * A registry that advertises nothing — the default when a worker runs without a Redis backend (e.g. an
 * in-process test transport, or before the tenant provider wires a real one). The runtime still BUILDS
 * its descriptor + heartbeat (observable via {@link import('./worker-runtime.js').WorkerRuntime.descriptor});
 * they simply aren't published anywhere.
 */
export class NoopWorkerRegistry implements WorkerRegistry {
  async advertiseDescriptor(): Promise<void> {
    /* no backend — nothing to publish */
  }

  async beat(): Promise<void> {
    /* no backend — nothing to publish */
  }
}

/**
 * The minimal Redis surface {@link RedisWorkerRegistry} needs — a structural subset satisfied by an
 * `ioredis` client AND by the bullmq transport's `RedisLike`, so either can be handed in without a hard
 * `ioredis` import at the worker subpath's module load. `set(...'EX', ttl)` is exactly the SET…EX the
 * aviary liveness-key scheme uses; `del`/`disconnect` are optional cleanup.
 */
export interface DescriptorRedis {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown> | unknown;
  del?(...keys: string[]): Promise<unknown> | unknown;
  disconnect?(): void;
}

/**
 * Publishes the descriptor + heartbeat to Redis with `SET key value EX ttl` — the byte-compatible
 * two-tier advertisement (design §7.2) a control-plane (or a Python/NestJS peer) reads off the shared
 * Redis. The client is injected (never constructed here) so this class stays pure and the worker
 * subpath pulls in no `ioredis` statically; a caller builds the client once (e.g. from the same
 * connection its bullmq transport uses) and passes it in.
 */
export class RedisWorkerRegistry implements WorkerRegistry {
  readonly #redis: DescriptorRedis;
  readonly #ownsConnection: boolean;

  constructor(redis: DescriptorRedis, opts: { ownsConnection?: boolean } = {}) {
    this.#redis = redis;
    this.#ownsConnection = opts.ownsConnection ?? false;
  }

  async advertiseDescriptor(ad: {
    key: string;
    descriptor: WorkerDescriptor;
    ttlSeconds: number;
  }): Promise<void> {
    await this.#redis.set(ad.key, JSON.stringify(ad.descriptor), 'EX', ad.ttlSeconds);
  }

  async beat(beat: { key: string; status: HeartbeatStatus; ttlSeconds: number }): Promise<void> {
    await this.#redis.set(beat.key, JSON.stringify(beat.status), 'EX', beat.ttlSeconds);
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length > 0 && this.#redis.del) await this.#redis.del(...keys);
  }

  async close(): Promise<void> {
    if (this.#ownsConnection) this.#redis.disconnect?.();
  }
}
