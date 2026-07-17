import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TenantVerifier, VerifiedTenant } from '../config_types.js';

/**
 * Layered tenant auth (spec §9). On a store-less pod the `tenant` on a `RunRequest`/`StartRunMessage`
 * is only a CLAIM; without a signed proof the isolation boundary is meaningless. This module provides
 * the default defense-in-depth on top of prefix/network isolation: a symmetric HMAC token a tenant pod
 * carries and presents in the `tenant` wire field, which the control-plane {@link TenantVerifier}
 * checks and DERIVES the real tenant from — never trusting the body.
 *
 * The token is deliberately tiny and self-describing (`<tenant>.<base64url-hmac>`), so it fits the
 * existing byte-compatible `tenant: string` wire field with NO envelope change: an aviary/Python
 * control plane that doesn't verify simply treats the whole string as the tenant name (and finds no
 * runs — a safe failure), while an Adonis control plane configured with {@link hmacTenantVerifier}
 * verifies the signature and scopes to the embedded tenant.
 *
 * HMAC (shared secret) is the zero-infra default; a deployment that prefers asymmetric / issued tokens
 * supplies its own {@link TenantVerifier} in `config/durable.ts` instead. Prefix/network segmentation
 * is a deployment concern (Redis ACLs, per-tenant prefixes) and lives outside this code.
 */

/** Separator between the tenant claim and its signature in a token. `.` is URL/JSON-safe and never
 *  appears in the base64url signature, so the LAST `.` unambiguously splits the two halves — a tenant
 *  name may itself contain dots. */
const TOKEN_SEP = '.';

/** The HMAC digest, byte-for-byte, that authenticates `tenant` under `secret`. */
function sign(tenant: string, secret: string): string {
  return createHmac('sha256', secret).update(tenant).digest('base64url');
}

/**
 * Mint the signed token a tenant pod presents: `` `${tenant}.${base64url(HMAC-SHA256(secret, tenant))}` ``.
 * Put it on the pod's `config/durable.ts` as `tenant.token`; the pod carries only the token (never the
 * secret), and the control plane verifies it with the SAME `secret` via {@link hmacTenantVerifier}.
 */
export function signTenantToken(tenant: string, secret: string): string {
  return `${tenant}${TOKEN_SEP}${sign(tenant, secret)}`;
}

/**
 * Build the control-plane-side {@link TenantVerifier} for {@link signTenantToken}-minted tokens under
 * `secret`. It parses the token, recomputes the HMAC over the embedded tenant, and compares it in
 * CONSTANT TIME (`timingSafeEqual`) — so a tampered tenant, a forged/absent signature, or a token
 * signed with a different secret all return `null` (rejected). The verified tenant is DERIVED from the
 * token's own claim, and the advisory `tenant` on the request body is ignored (spec §9).
 *
 * `capabilities`, if given, is a static grant stamped onto every {@link VerifiedTenant} this verifier
 * authenticates (the HMAC token carries no scoped claims of its own); omit for none.
 */
export function hmacTenantVerifier(secret: string, capabilities?: string[]): TenantVerifier {
  return ({ token }): VerifiedTenant | null => {
    // The signed token travels in the request's `tenant` field, so the responder passes it as `token`.
    if (typeof token !== 'string' || token.length === 0) return null;
    const sep = token.lastIndexOf(TOKEN_SEP);
    if (sep <= 0 || sep === token.length - 1) return null; // no claim or no signature half
    const tenant = token.slice(0, sep);
    const presented = token.slice(sep + 1);
    const expected = sign(tenant, secret);
    if (!constantTimeEquals(presented, expected)) return null;
    return capabilities !== undefined ? { tenant, capabilities } : { tenant };
  };
}

/** Constant-time string compare that never throws on a length mismatch (`timingSafeEqual` requires
 *  equal-length buffers) and never short-circuits on the first differing byte — so a rejected token
 *  leaks nothing about how much of the signature matched. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
