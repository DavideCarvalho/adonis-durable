import type { ControlMessage, Heartbeat, RemoteTask, StepResult } from '@agora/durable-core';

/**
 * The wire payloads carried in the transport's table rows. Everything crossing the DB is plain JSON
 * — a `RemoteTask` (engine → worker), a `StepResult` / `Heartbeat` (worker → engine) and a
 * `ControlMessage` (best-effort, see DESIGN.md). JSON columns are stored as TEXT, so these helpers
 * (de)serialize through `JSON.stringify`/`JSON.parse`: only JSON-safe values survive (functions,
 * symbols, `undefined` members are dropped exactly as a real broker would drop them).
 */

/** Serialize a value to a JSON string, or `null` for `undefined` (so a TEXT column round-trips). */
export function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Parse a TEXT column we previously wrote with {@link toJson}. `null`/empty → `undefined`. */
export function fromJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return JSON.parse(value) as T;
}

export type TaskPayload = RemoteTask;
export type ResultPayload = StepResult;
export type HeartbeatPayload = Heartbeat;
export type ControlPayload = ControlMessage;
