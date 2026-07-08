import { timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * Authorization guard for the dashboard. Runs before every dashboard route
 * (API + HTML). Return `true` to allow the request, `false` to deny it (the
 * provider replies `403`). May be async (e.g. an auth lookup).
 *
 * It receives the AdonisJS {@link HttpContext}, so it can read the session,
 * a bearer token, an IP allow-list, etc.
 */
export type AuthorizeHook = (ctx: HttpContext) => boolean | Promise<boolean>;

/** Shape of `config/durable_dashboard.ts`. */
export interface DurableDashboardConfig {
  /**
   * Master switch. When `false`, the provider registers no routes at all — the
   * dashboard is completely absent. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * URL prefix the dashboard + its API mount under. Defaults to `/durable`.
   * The HTML is served at the prefix root; the JSON API lives under
   * `<path>/api`.
   */
  path?: string;
  /**
   * Per-request authorization guard. Defaults to {@link defaultAuthorize}:
   * allow everything OUTSIDE production, and in production require a bearer
   * token matching the `DURABLE_DASHBOARD_TOKEN` env var (deny if it is unset).
   */
  authorize?: AuthorizeHook;
}

/** A fully-resolved config — every field present (defaults applied). */
export interface ResolvedDurableDashboardConfig {
  enabled: boolean;
  path: string;
  authorize: AuthorizeHook;
}

/**
 * Whether the process is running in production. Mirrors how AdonisJS reads the
 * environment without taking a hard dependency on its env service.
 */
function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/**
 * Extract a bearer token from an `Authorization: Bearer <token>` header, a
 * `token` query-string param, or an `x-durable-token` header — whichever is
 * present. Returns `undefined` when none is supplied.
 */
function readToken(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match?.[1]) return match[1].trim();
  }
  const xHeader = ctx.request.header('x-durable-token');
  if (xHeader) return xHeader.trim();
  const qs = ctx.request.qs().token;
  if (typeof qs === 'string' && qs.length > 0) return qs;
  return undefined;
}

/**
 * Compare two secrets in constant time (guarding for equal byte-length first,
 * since {@link timingSafeEqual} throws on a length mismatch). Returns `false`
 * for any length difference, otherwise the timing-safe equality — so the token
 * check leaks neither a match nor the token's length via response time.
 */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The default guard: open outside production; in production it requires a
 * bearer token equal to `DURABLE_DASHBOARD_TOKEN`. If that env var is unset in
 * production the dashboard is denied entirely (fail-closed) — you must opt in
 * by setting a token or supplying your own {@link AuthorizeHook}.
 */
export function defaultAuthorize(ctx: HttpContext): boolean {
  if (!isProduction()) return true;
  const expected = process.env.DURABLE_DASHBOARD_TOKEN;
  if (!expected) return false;
  const provided = readToken(ctx);
  if (provided === undefined) return false;
  // Constant-time compare to remove the timing side-channel from the token check.
  return secretsMatch(provided, expected);
}

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(config: DurableDashboardConfig = {}): ResolvedDurableDashboardConfig {
  const rawPath = config.path ?? '/durable';
  // Normalize: ensure a single leading slash and no trailing slash (root stays '/').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return {
    enabled: config.enabled ?? true,
    path: trimmed === '/' ? '' : trimmed,
    authorize: config.authorize ?? defaultAuthorize,
  };
}

/** Identity helper giving `config/durable_dashboard.ts` full type-checking. */
export function defineConfig(config: DurableDashboardConfig = {}): DurableDashboardConfig {
  return config;
}
