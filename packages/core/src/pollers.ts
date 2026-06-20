/** A running poll loop. Call {@link PollLoop.stop} to end just this one. */
export interface PollLoop {
  stop(): void;
}

/**
 * The shared poll-loop lifecycle for poll-based transports (DB-row pollers, queue-adapter
 * pollers). Each loop runs its `tick` repeatedly: while a tick reports it did work the loop
 * keeps draining without sleeping (so a burst is processed promptly), then sleeps `intervalMs`
 * once a tick comes back empty. A throwing tick is reported to `onError` (if given) and the loop
 * survives. Every loop is tracked so {@link stopAll} can end them together on shutdown.
 *
 * Timers are `unref`'d so a quiescent poller never holds the process open.
 *
 * This is the one place the queue- and DB-backed transports would otherwise duplicate the subtle
 * recursive-`setTimeout` / drain-burst / stop-all bookkeeping; both drive it through this class.
 */
export class Pollers {
  readonly #loops = new Set<PollLoop>();
  readonly #intervalMs: number;
  readonly #onError: ((err: unknown) => void) | undefined;
  #closed = false;

  constructor(intervalMs: number, onError?: (err: unknown) => void) {
    this.#intervalMs = intervalMs;
    this.#onError = onError;
  }

  /** Whether {@link stopAll} has been called — loops won't run until {@link reopen}. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Re-open after a {@link stopAll} so loops started afterwards may run again. */
  reopen(): void {
    this.#closed = false;
  }

  /**
   * Start a loop driven by `tick`. `tick` resolves to whether it did any work this round; while it
   * keeps returning `true` the loop drains without sleeping, then sleeps `intervalMs` once a round
   * is empty. Returns a handle that stops just this loop (also stopped by {@link stopAll}).
   */
  start(tick: () => Promise<boolean>): PollLoop {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      if (stopped || this.#closed) return;
      try {
        let worked = await tick();
        while (worked && !stopped && !this.#closed) {
          worked = await tick();
        }
      } catch (err) {
        if (!stopped && !this.#closed) this.#onError?.(err);
      }
      if (!stopped && !this.#closed) {
        timer = setTimeout(() => void run(), this.#intervalMs);
        timer.unref?.();
      }
    };

    const loop: PollLoop = {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        this.#loops.delete(loop);
      },
    };
    this.#loops.add(loop);
    void run();
    return loop;
  }

  /** Stop and forget every running loop, and mark closed so in-flight ticks stop early. */
  stopAll(): void {
    this.#closed = true;
    for (const loop of this.#loops) loop.stop();
    this.#loops.clear();
  }
}
