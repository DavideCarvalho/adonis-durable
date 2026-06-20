import { type Context, context, propagation } from '@opentelemetry/api';

/**
 * The current active span as a W3C `traceparent` string, or `undefined` when there's no active span
 * (or no propagator registered). Wire it into the engine so remote steps continue the trace on the
 * worker:
 *
 * ```ts
 * new WorkflowEngine({ store, transport, traceparent: () => otelTraceparent() });
 * ```
 *
 * Uses the globally-registered OTel propagator (`propagation.inject`), so a standard W3C setup needs
 * no extra wiring. (When `@agora/diagnostics` is installed its OTel bridge already publishes the same
 * value on the `@agora/otel:traceparent` slot the durable provider reads — this is the standalone
 * helper for setups without `@agora/diagnostics`.)
 */
export function otelTraceparent(ctx: Context = context.active()): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent;
}
