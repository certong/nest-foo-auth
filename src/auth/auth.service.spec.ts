import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PinLockout } from './pin-lockout';
import { verifyToken } from './session-token';
import { TOKEN_KEYS } from './token-keys';

const META: RequestMeta = { portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' };
const SID = '6b1f0a52-3c1e-4d8e-9a57-1f2e3d4c5b6a';
const STAFF = { accountType: 'staff' as const, clientId: null, disabledAt: null };
const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';

async function buildService(row: unknown) {
  // By email for sign-in; by id for the account read refresh makes.
  const findUnique = vi.fn(({ where }: { where: { email?: string; id?: string } }) =>
    Promise.resolve(where.email !== undefined ? row : where.id === USER_ID ? STAFF : null),
  );
  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      PinLockout,
      { provide: PrismaService, useValue: { account: { findUnique } } },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record: () => Promise.resolve() } },
    ],
  }).compile();
  return { service: moduleRef.get(AuthService), findUnique };
}

/**
 * AuthService.validateCredentials is gone: password sign-in is retired at both
 * portals (studio since FA-24, billing once a PIN alone was enough there), so
 * there is no password path left to test. The facts these cases pinned down —
 * an unknown email rejected identically to a wrong credential, the Argon2 time
 * spent either way, the lookup keyed on the address given — are asserted for
 * the PIN door in auth-pin.service.spec.ts.
 */

describe('AuthService token minting', () => {
  const CLAIMS = { id: USER_ID, email: 'admin@example.com', sid: SID, accountType: 'staff' as const, clientId: null };

  it('mints an access token for the requested portal', async () => {
    const { service } = await buildService(null);
    const token = await service.createAccessToken(CLAIMS, 'studio');

    await expect(verifyToken(token, await testKeys(), 'access', 'studio')).resolves.toEqual(CLAIMS);
    await expect(verifyToken(token, await testKeys(), 'access', 'billing')).resolves.toBeNull();
  });

  it('mints a refresh token that cannot be used as an access token', async () => {
    const { service } = await buildService(null);
    const token = await service.createRefreshToken(CLAIMS);

    await expect(verifyToken(token, await testKeys(), 'refresh')).resolves.toEqual(CLAIMS);
    await expect(verifyToken(token, await testKeys(), 'access', 'billing')).resolves.toBeNull();
  });
});

describe('AuthService.refresh', () => {
  const CLAIMS = { id: USER_ID, email: 'admin@example.com', sid: SID, accountType: 'staff' as const, clientId: null };

  it('exchanges a refresh token for its claims, sid included', async () => {
    const { service } = await buildService(null);

    await expect(service.refresh(await service.createRefreshToken(CLAIMS), META)).resolves.toEqual(CLAIMS);
  });

  it('rejects a missing or empty cookie', async () => {
    const { service } = await buildService(null);

    await expect(service.refresh(undefined, META)).rejects.toThrow(UnauthorizedException);
    await expect(service.refresh('', META)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an access token presented as a refresh token', async () => {
    // The mirror of the guard's rule: one kind of token, one job. Without it,
    // the short-lived credential could buy itself an unlimited extension.
    const { service } = await buildService(null);

    await expect(service.refresh(await service.createAccessToken(CLAIMS, 'billing'), META)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects garbage', async () => {
    const { service } = await buildService(null);

    await expect(service.refresh('not.a.token', META)).rejects.toThrow(UnauthorizedException);
  });
});
