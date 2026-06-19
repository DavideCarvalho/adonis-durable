import type { Heartbeat, RemoteTask, StepResult } from '@agora/durable-core';
import type { ControlMessage } from '@agora/durable-core';

/**
 * The wire payloads carried as a queue job's `payload`. Everything that crosses the queue is plain
 * JSON — a `RemoteTask` (engine → worker), a `StepResult` / `Heartbeat` (worker → engine) and a
 * `ControlMessage` (best-effort, see DESIGN.md). The adapter stores `payload: any`, so these helpers
 * round-trip through `JSON.stringify`/`JSON.parse` to guarantee that only JSON-safe values survive
 * (functions, symbols, `undefined` members are dropped exactly as a real broker would drop them).
 */

/** Serialize a value to a JSON-safe clone. Throws on a non-serializable value (e.g. a cycle). */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Parse a job payload that we previously wrote with {@link toJson}. */
export function fromJson<T>(value: unknown): T {
  // The adapter already gives us a structured value; if a driver hands back a raw string
  // (some persist `payload` as text), decode it. Otherwise pass it straight through.
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export type TaskPayload = RemoteTask;
export type ResultPayload = StepResult;
export type HeartbeatPayload = Heartbeat;
export type ControlPayload = ControlMessage;
