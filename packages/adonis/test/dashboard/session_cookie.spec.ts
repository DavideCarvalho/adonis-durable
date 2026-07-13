import { describe, expect, it } from 'vitest';
import { signSessionCookie, verifySessionCookie } from '../../src/dashboard/session_cookie.js';

const SECRET = 'a-very-not-secret-test-key';

describe('session cookie sign/verify (round-trip)', () => {
  it('signs and verifies a session, round-tripping id/name/roles', () => {
    const now = Date.now();
    const cookie = signSessionCookie(
      { id: 'ops', name: 'Ops', roles: ['admin'] },
      { secret: SECRET, ttlMs: 60_000, now },
    );

    const session = verifySessionCookie(cookie, { secret: SECRET, now });

    expect(session).toEqual({
      sub: 'ops',
      name: 'Ops',
      roles: ['admin'],
      iat: now,
      exp: now + 60_000,
    });
  });

  it('defaults roles to an empty array when omitted', () => {
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    const session = verifySessionCookie(cookie, { secret: SECRET });
    expect(session?.roles).toEqual([]);
    expect(session?.name).toBeUndefined();
  });

  it('rejects a cookie signed with a different secret (tamper detection)', () => {
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    expect(verifySessionCookie(cookie, { secret: 'wrong-secret' })).toBeNull();
  });

  it('rejects a cookie whose payload was tampered with (signature no longer matches)', () => {
    const cookie = signSessionCookie({ id: 'ops', roles: [] }, { secret: SECRET, ttlMs: 60_000 });
    const [payload, signature] = cookie.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: 'admin', roles: ['admin'], iat: Date.now(), exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url');
    expect(verifySessionCookie(`${tamperedPayload}.${signature}`, { secret: SECRET })).toBeNull();
    expect(payload).toBeDefined();
  });

  it('rejects an expired cookie past the 30s grace', () => {
    const now = Date.now();
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 1000, now });
    expect(verifySessionCookie(cookie, { secret: SECRET, now: now + 1000 + 30_001 })).toBeNull();
  });

  it('accepts a cookie just past expiry but within the 30s clock-skew grace', () => {
    const now = Date.now();
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 1000, now });
    expect(verifySessionCookie(cookie, { secret: SECRET, now: now + 1000 + 10_000 })).not.toBeNull();
  });

  it('never throws on garbage input', () => {
    expect(verifySessionCookie('', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('not-a-cookie', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('.', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('abc.', { secret: SECRET })).toBeNull();
  });
});
