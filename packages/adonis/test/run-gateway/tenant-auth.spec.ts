import { describe, expect, it } from 'vitest';
import { hmacTenantVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';

const SECRET = 'super-secret-signing-key';

// `await` (not `.resolves`) because the HMAC verifier answers SYNCHRONOUSLY — awaiting a plain value is
// a no-op, so the same assertions would also hold for an async verifier.
describe('tenant-auth (HMAC signed token, spec §9)', () => {
  it('verifies a token minted with the same secret and DERIVES the tenant from it', async () => {
    const token = signTenantToken('acme', SECRET);
    const verify = hmacTenantVerifier(SECRET);
    // The token travels in the request `tenant` field, so the responder passes it as `token`.
    expect(await verify({ token, tenant: token })).toEqual({ tenant: 'acme' });
  });

  it('derives the tenant from the TOKEN, ignoring any advisory `tenant` in the body', async () => {
    const token = signTenantToken('acme', SECRET);
    const verify = hmacTenantVerifier(SECRET);
    // A lying body claim ('evil') must NOT change the derived identity.
    expect(await verify({ token, tenant: 'evil' })).toEqual({ tenant: 'acme' });
  });

  it('stamps static capabilities onto the verified tenant when configured', async () => {
    const token = signTenantToken('acme', SECRET);
    const verify = hmacTenantVerifier(SECRET, ['saga', 'signals']);
    expect(await verify({ token })).toEqual({ tenant: 'acme', capabilities: ['saga', 'signals'] });
  });

  it('REJECTS a token whose tenant claim was tampered (signature no longer matches)', async () => {
    const token = signTenantToken('acme', SECRET);
    const sig = token.slice(token.lastIndexOf('.') + 1);
    const tampered = `evil.${sig}`; // keep acme's signature, swap the claim
    const verify = hmacTenantVerifier(SECRET);
    expect(await verify({ token: tampered })).toBeNull();
  });

  it('REJECTS a token whose signature was tampered', async () => {
    const token = signTenantToken('acme', SECRET);
    const verify = hmacTenantVerifier(SECRET);
    expect(await verify({ token: `${token}x` })).toBeNull();
  });

  it('REJECTS a token signed with a different secret', async () => {
    const token = signTenantToken('acme', 'a-different-secret');
    const verify = hmacTenantVerifier(SECRET);
    expect(await verify({ token })).toBeNull();
  });

  it('REJECTS a malformed / empty / signature-less token', async () => {
    const verify = hmacTenantVerifier(SECRET);
    expect(await verify({ token: '' })).toBeNull();
    expect(await verify({ token: undefined })).toBeNull();
    expect(await verify({ token: 'no-separator' })).toBeNull();
    expect(await verify({ token: 'acme.' })).toBeNull();
    expect(await verify({ token: '.sig' })).toBeNull();
  });

  it('preserves a tenant name containing dots (splits on the LAST separator)', async () => {
    const token = signTenantToken('team.acme.eu', SECRET);
    const verify = hmacTenantVerifier(SECRET);
    expect(await verify({ token })).toEqual({ tenant: 'team.acme.eu' });
  });
});
