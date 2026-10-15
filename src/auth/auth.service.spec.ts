import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, INVALID_CREDENTIALS, USE_PIN_SIGN_IN } from './auth.service';
import { hashPassword } from './password';
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

describe('AuthService.validateCredentials', () => {
  it('returns the claims for a correct password', async () => {
    const passwordHash = await hashPassword('s3cret-password');
    const { service } = await buildService({ id: USER_ID, email: 'admin@example.com', passwordHash, ...STAFF });

    await expect(service.validateCredentials('admin@example.com', 's3cret-password', META)).resolves.toEqual({
      id: USER_ID,
      email: 'admin@example.com',
      sid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountType: 'staff',
      clientId: null,
    });
  });

  it('refuses every password sign-in at studio with 403, before looking anything up', async () => {
    // Studio is PIN-only (FA-24). Refusing before the lookup means the answer
    // is the same for every email, so it cannot reveal which ones exist.
    const passwordHash = await hashPassword('s3cret-password');
    const { service, findUnique } = await buildService({ id: USER_ID, email: 'admin@example.com', passwordHash, ...STAFF });

    const studio = { ...META, portal: 'studio' as const };
    for (const password of ['s3cret-password', 'wrong']) {
      await expect(service.validateCredentials('admin@example.com', password, studio)).rejects.toThrow(
        new ForbiddenException(USE_PIN_SIGN_IN),
      );
    }
    await expect(service.validateCredentials('nobody@example.com', 'x', studio)).rejects.toThrow(USE_PIN_SIGN_IN);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await hashPassword('s3cret-password');
    const { service } = await buildService({ id: USER_ID, email: 'admin@example.com', passwordHash, ...STAFF });

    await expect(service.validateCredentials('admin@example.com', 'wrong', META)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('gives an unknown email the identical rejection, never a hint that it is unknown', async () => {
    const { service } = await buildService(null);

    await expect(service.validateCredentials('nobody@example.com', 'whatever', META)).rejects.toThrow(
      INVALID_CREDENTIALS,
    );
  });

  it('still spends verify time on an unknown email', async () => {
    // Returning early for a missing row leaks, through response timing, which
    // address is the administrator's.
    const { service } = await buildService(null);

    const started = performance.now();
    await service.validateCredentials('nobody@example.com', 'whatever', META).catch(() => undefined);
    expect(performance.now() - started).toBeGreaterThan(5);
  });

  it('looks the user up by the email it was given', async () => {
    const { service, findUnique } = await buildService(null);

    await service.validateCredentials('admin@example.com', 'whatever', META).catch(() => undefined);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'admin@example.com' } });
  });
});

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
