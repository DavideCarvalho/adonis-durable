import type { ControlMessage, ControlPlane } from '../index.js';

/**
 * The minimal Redis pub/sub surface this control plane needs. BOTH a raw `ioredis` instance and an
 * `@adonisjs/redis` connection satisfy it structurally, so we depend on the surface rather than a
 * concrete type — keeping the peer coupling minimal and the driver testable.
 *
 * The two clients differ in how a subscriber is obtained:
 * - **raw ioredis**: a subscriber connection can't run normal commands, so `duplicate()` a dedicated
 *   one, `subscribe(channel)` on it, and receive via `.on('message', (channel, message) => ...)`.
 * - **`@adonisjs/redis` connection**: `subscribe(channel, (message) => ...)` manages its own
 *   subscriber connection internally — no duplicate needed; the handler receives the message directly.
 *
 * We detect which one we have by feature: a raw ioredis client exposes `duplicate()`; the
 * `@adonisjs/redis` connection does not (it hides its `ioConnection`).
 */
export interface RedisPubSub {
  /** Publish a message to a channel (both clients return a promise-ish here). */
  publish(channel: string, message: string): unknown;
  /**
   * Subscribe to a channel. ioredis takes only the channel (messages arrive via `on('message')`);
   * the `@adonisjs/redis` connection takes a channel + a per-message handler.
   */
  subscribe(channel: string, handler?: (message: string, channel: string) => void): unknown;
  /** ioredis-only: per-message event used when a dedicated subscriber connection is duplicated. */
  on?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  /** ioredis-only: build a dedicated subscriber connection (pub/sub can't share a command client). */
  duplicate?(): RedisPubSub;
  /** ioredis-only: tear down the duplicated subscriber connection. */
  disconnect?(): void;
}

export interface RedisControlPlaneOptions {
  /** An ioredis instance or an `@adonisjs/redis` connection used for pub/sub. */
  connection: RedisPubSub;
  /**
   * Key prefix namespacing the control channel. Defaults to `durable`. The channel is
   * `` `${prefix}-control` `` — matched EXACTLY to the NestJS BullMQ transport so an AdonisJS fleet
   * and a NestJS fleet sharing one Redis interoperate on the same control plane.
   */
  prefix?: string;
}

/**
 * A {@link ControlPlane} backed by Redis pub/sub: the cross-pod broadcast channel for workflow
 * **lifecycle events** (so a dashboard-only pod can live-tail a run executing on a worker pod) and
 * **cancellation** (so the pod actually running a run learns it was cancelled elsewhere).
 *
 * This is purely out-of-band signalling — it carries NO replay/determinism weight; the engine
 * already dedupes self-broadcasts by `msg.from`, so a publish Redis echoes back to its own subscriber
 * is ignored. Omit a control plane entirely and the engine is local-only (single instance).
 *
 * The channel name (`` `${prefix}-control` ``) and the JSON payload match the NestJS BullMQ
 * transport, so a mixed AdonisJS + NestJS fleet on one Redis fans out across both runtimes.
 */
export class RedisControlPlane implements ControlPlane {
  private readonly connection: RedisPubSub;
  private readonly channel: string;
  private subscriber: RedisPubSub | undefined;
  private subscribed = false;

  constructor(options: RedisControlPlaneOptions) {
    this.connection = options.connection;
    this.channel = `${options.prefix ?? 'durable'}-control`;
  }

  async publishControl(msg: ControlMessage): Promise<void> {
    await this.connection.publish(this.channel, JSON.stringify(msg));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    if (this.subscribed) return; // one subscription per control plane
    this.subscribed = true;

    const deliver = (payload: string) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(payload) as ControlMessage;
      } catch {
        return; // swallow malformed payloads — a control message must never crash the engine
      }
      handler(msg);
    };

    if (typeof this.connection.duplicate === 'function') {
      // raw ioredis: a subscriber connection can't run normal commands → use a dedicated dup.
      const sub = this.connection.duplicate();
      this.subscriber = sub;
      void sub.subscribe(this.channel);
      sub.on?.('message', (_channel, payload) => deliver(payload));
    } else {
      // `@adonisjs/redis` connection: manages its own subscriber connection; handler gets the message.
      void this.connection.subscribe(this.channel, (payload) => deliver(payload));
    }
  }

  /** Tear down the dedicated subscriber connection, if one was duplicated (ioredis path). */
  async close(): Promise<void> {
    this.subscriber?.disconnect?.();
    this.subscriber = undefined;
  }
}
