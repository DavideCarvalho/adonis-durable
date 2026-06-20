import type { EngineEvent } from './interfaces.js';

/** The minimal engine surface the bridge needs: a lifecycle-event subscription. */
export interface DurableEventSource {
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

/** The `@agora/diagnostics` emit capability, published on this slot at that package's module load. */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * Bridge every engine lifecycle event onto the `@agora/diagnostics` bus as `agora:durable:<type>`
 * (e.g. `agora:durable:run.failed`); the whole {@link EngineEvent} is the payload. The emit
 * capability is read STRUCTURALLY from its global slot per event — durable never imports or depends
 * on `@agora/diagnostics`, and when diagnostics isn't installed the slot is empty and this is an
 * inert subscription.
 *
 * One bridge lights up everything downstream of the diagnostics hub at once: `onDiagnostic('durable')`
 * subscribers, the Telescope generic watcher (which auto-captures every channel), the cross-process
 * relays, and the OTel bridge (each event recorded on the active span). `emit` short-circuits on
 * `hasSubscribers`, so an unsubscribed channel costs nothing, and it never throws back into the
 * engine. All event types are forwarded verbatim — filtering is the subscriber's job.
 *
 * @returns an unsubscribe function that detaches the bridge from the engine.
 */
export function attachDurableDiagnostics(engine: DurableEventSource): () => void {
  return engine.subscribe((event: EngineEvent) => {
    const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
    if (typeof emit === 'function') emit('durable', event.type, event);
  });
}
