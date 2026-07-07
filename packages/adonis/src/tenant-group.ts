/**
 * Compute the worker group a partitioned step dispatches to. Mirrors the transport's
 * default-is-bare rule: a `partition` of `undefined`, `''`, or `'default'` is the bare `baseGroup`,
 * so a single-pool deployment (or the `'default'` partition of a multi-pool one) stays
 * byte-identical to today. Any other partition suffixes the group as `<baseGroup>@<partition>`, so a
 * step can be isolated onto its own worker pool without changing its routing identity (the `name`).
 */
export function tenantGroup(baseGroup: string, partition: string | undefined): string {
  return partition !== undefined && partition !== '' && partition !== 'default'
    ? `${baseGroup}@${partition}`
    : baseGroup;
}

/**
 * Sanitize a handler/workflow name for use as a broker queue token: some brokers (BullMQ) forbid `:`
 * in queue names (it is used internally as a key separator), so every `:` is replaced with `-`. `.`
 * is legal in a queue name and is left as-is — step/workflow names commonly use it as a namespacing
 * separator (e.g. `payments.charge-card`). Apply this IDENTICALLY at every dispatch site AND every
 * subscribe/queue site, or a step whose name contains a `:` would be dispatched to one token and
 * served from another — and silently never run.
 */
export function sanitizeQueueToken(name: string): string {
  return name.replace(/:/g, '-');
}
