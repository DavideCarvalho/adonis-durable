import { effectivePrefix, routingToken, workerHeartbeatKey } from '../transports/bullmq/naming.js';

/**
 * Broker key naming for the store-less {@link import('./worker-runtime.js').WorkerRuntime}'s two-tier
 * advertisement (design §6.2 / §7.2). Built ON TOP of the wave-1 aviary-compatible
 * `transports/bullmq/naming` so the worker-liveness + descriptor keys stay byte-identical across the
 * fleet (a Python worker / NestJS control-plane computes the same names). Pure string builders — no
 * Redis, no bullmq, no Lucid — so the worker subpath stays lean and the names unit-test in isolation.
 *
 * Re-exported here (rather than re-derived) so a caller in the worker subpath never has to reach into
 * the bullmq transport package for the shared sanitize/prefix/token rules.
 */
export { effectivePrefix, routingToken, workerHeartbeatKey };

/**
 * `${P}-worker-descriptor:${token}:${instanceId}` — the full {@link WorkerDescriptor} key (design
 * §6.2). One key per (routing token, instance): the worker publishes its whole descriptor under EACH
 * routing token it serves, mirroring the per-token `${P}-worker-heartbeat:` liveness key so a
 * control-plane scanning a token's keyspace finds both the compact heartbeat (with the ETag) and, when
 * the ETag changed, the rich descriptor to re-read. Neither `token` nor `instanceId` carries a `:`, so
 * the segments parse unambiguously — identical to {@link workerHeartbeatKey}'s layout.
 */
export function workerDescriptorKey(effPrefix: string, token: string, instanceId: string): string {
  return `${effPrefix}-worker-descriptor:${token}:${instanceId}`;
}

/** Common prefix of every worker-descriptor key (for a control-plane SCAN over live descriptors). */
export function workerDescriptorKeyPrefix(effPrefix: string): string {
  return `${effPrefix}-worker-descriptor:`;
}
