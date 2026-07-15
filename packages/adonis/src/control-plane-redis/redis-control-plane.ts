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
  /**
   * ioredis-only: connection events. `message` delivers a payload on a duplicated subscriber;
   * `error`/`ready`/`subscribe` are used by the watchdog (see {@link RedisControlPlaneOptions.pingIntervalMs}).
   */
  on?(event: string, listener: (...args: never[]) => void): unknown;
  /** ioredis-only: build a dedicated subscriber connection (pub/sub can't share a command client). */
  duplicate?(): RedisPubSub;
  /**
   * ioredis-only: tear down the duplicated subscriber connection. `disconnect(true)` reconnects
   * (ioredis's `retryStrategy` + `autoResubscribe`) rather than closing for good.
   */
  disconnect?(reconnect?: boolean): void;
  /** ioredis-only: liveness probe. Legal in subscriber mode (ioredis's `VALID_IN_SUBSCRIBER_MODE`). */
  ping?(): Promise<unknown>;
  /** ioredis-only: connection state — the watchdog skips anything that isn't `'ready'`. */
  status?: string;
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
  /**
   * How often (ms) to PING the duplicated pub/sub subscriber connection to detect — and recover
   * from — a silent connection loss. A subscriber connection never WRITEs on its own (it only
   * receives PUBLISHed messages), so when a VPN/NAT/idle-timeout drops the underlying TCP
   * connection, ioredis has nothing that would surface the loss: no write ever fails, no timeout
   * ever fires, and the connection sits "subscribed" forever while the server's `PUBSUB NUMSUB`
   * already shows 0 — cross-pod cancels and lifecycle events silently stop arriving until the
   * process restarts. A PING rejection or timeout means the connection is dead, so we
   * `disconnect(true)` it: ioredis's `retryStrategy` reconnects and `autoResubscribe` (default
   * `true`) restores the channel automatically.
   *
   * Pass `0` or `false` to disable (e.g. a short-lived test where the interval would outlive it).
   * Defaults to `30_000`. Only applies to the raw-ioredis path — an `@adonisjs/redis` connection
   * manages its own subscriber connection and its own health.
   */
  pingIntervalMs?: number | false;
}

/** Default {@link RedisControlPlaneOptions.pingIntervalMs}. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** How long a single watchdog PING may take before its subscriber is presumed dead. */
const SUBSCRIBER_PING_TIMEOUT_MS = 5_000;

/**
 * Normalise `pingIntervalMs`: `undefined` → the default, `0`/`false` → disabled, any other number
 * → itself verbatim (including a caller's smaller interval for short-lived tests).
 */
function normalizePingInterval(value: number | false | undefined): number | false {
  if (value === undefined) return DEFAULT_PING_INTERVAL_MS;
  if (value === false || value === 0) return false;
  return value;
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
  private readonly pingIntervalMs: number | false;
  private pingWatchdogTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: RedisControlPlaneOptions) {
    this.connection = options.connection;
    this.channel = `${options.prefix ?? 'durable'}-control`;
    this.pingIntervalMs = normalizePingInterval(options.pingIntervalMs);
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
      sub.on?.('message', ((_channel: string, payload: string) => deliver(payload)) as never);
      this.trackSubscriber(sub);
    } else {
      // `@adonisjs/redis` connection: manages its own subscriber connection; handler gets the message.
      void this.connection.subscribe(this.channel, (payload) => deliver(payload));
    }
  }

  /**
   * Attach a de-duplicated `error` listener to the duplicated subscriber and start the ping
   * watchdog. The `error` listener is not optional hygiene: an unhandled `error` event on an
   * ioredis instance crashes the process in some setups, and a dead/reconnecting subscriber emits
   * them in bursts — so this connection, which nothing else listens to, would take the app down.
   */
  private trackSubscriber(sub: RedisPubSub): void {
    let loggedSinceReady = false;
    sub.on?.('error', ((err: Error) => {
      if (loggedSinceReady) return; // one line per reconnect burst, not one per retry
      loggedSinceReady = true;
      console.warn(`[adonis-durable] control-plane subscriber error: ${err.message}`);
    }) as never);
    sub.on?.('ready', (() => {
      loggedSinceReady = false;
    }) as never);
    this.startPingWatchdog(sub);
  }

  /**
   * Start the watchdog interval, unless it's disabled or already running (idempotent). Unref'd so
   * it never keeps the process alive on its own; cleared in {@link close}.
   */
  private startPingWatchdog(sub: RedisPubSub): void {
    if (this.pingWatchdogTimer || this.pingIntervalMs === false) return;
    if (typeof sub.ping !== 'function') return; // not an ioredis-shaped connection — nothing to probe
    this.pingWatchdogTimer = setInterval(() => {
      void this.pingSubscriber(sub);
    }, this.pingIntervalMs);
    this.pingWatchdogTimer.unref?.();
  }

  /**
   * PING the subscriber; on rejection or timeout, `disconnect(true)` so ioredis's `retryStrategy`
   * reconnects and `autoResubscribe` restores the channel. Skips a connection that isn't `'ready'`
   * — it's already mid-(re)connect, so a fresh ping would just race that cycle.
   *
   * The timeout is capped at `pingIntervalMs` itself (never above `SUBSCRIBER_PING_TIMEOUT_MS`):
   * waiting longer than the gap between checks to declare one dead would just mean two checks race
   * each other, and it lets a short interval shrink the whole detect → reconnect cycle instead of
   * always eating the full multi-second default.
   */
  private async pingSubscriber(sub: RedisPubSub): Promise<void> {
    if (sub.status !== undefined && sub.status !== 'ready') return;
    const timeoutMs =
      this.pingIntervalMs === false
        ? SUBSCRIBER_PING_TIMEOUT_MS
        : Math.min(SUBSCRIBER_PING_TIMEOUT_MS, this.pingIntervalMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
        sub
          .ping?.()
          .then(() => {
            clearTimeout(timer);
            resolve();
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    } catch (err) {
      // A ping in flight when close() lands would otherwise RESURRECT the connection we just tore
      // down: disconnect(true) reconnects rather than closes. Re-check after the await.
      if (this.closed) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[adonis-durable] control-plane subscriber unresponsive (${message}) — reconnecting to restore its subscription`,
      );
      sub.disconnect?.(true);
    }
  }

  /** Stop the watchdog and tear down the dedicated subscriber connection (ioredis path). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pingWatchdogTimer) clearInterval(this.pingWatchdogTimer);
    this.pingWatchdogTimer = undefined;
    this.subscriber?.disconnect?.();
    this.subscriber = undefined;
  }
}
