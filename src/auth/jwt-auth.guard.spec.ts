import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { testKeys } from '../../test/test-keys';
import { REFRESH_COOKIE_NAME } from './session-cookie';
import { JwtAuthGuard } from './jwt-auth.guard';
import { signAccessToken, signRefreshToken } from './session-token';
import { TokenKeys } from './token-keys';

const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const SID = '6b1f0a52-3c1e-4d8e-9a57-1f2e3d4c5b6a';
const CLAIMS = { id: USER_ID, email: 'admin@example.com', sid: SID, accountType: 'staff' as const, clientId: null };

let KEYS: TokenKeys;
let OTHER_KEYS: TokenKeys;
beforeAll(async () => {
  KEYS = await testKeys();
  OTHER_KEYS = await testKeys('some-other-key');
});

function contextWith(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(isPublic = false): JwtAuthGuard {
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
  return new JwtAuthGuard(reflector, KEYS);
}

/** A request PortalGuard has already assigned to billing. */
const bearer = (token: string, portal = 'billing') => ({ portal, headers: { authorization: `Bearer ${token}` } });

describe('JwtAuthGuard', () => {
  it('admits a valid bearer token and populates request.user without the sid', async () => {
    const request: Record<string, unknown> = bearer(await signAccessToken(CLAIMS, 'billing', KEYS));

    await expect(buildGuard().canActivate(contextWith(request))).resolves.toBe(true);
    expect(request.user).toEqual({ id: USER_ID, email: 'admin@example.com', accountType: 'staff' });
  });

  it('lets a @Public() route through with no token', async () => {
    await expect(buildGuard(true).canActivate(contextWith({}))).resolves.toBe(true);
  });
});

describe('JwtAuthGuard rejects, indistinguishably', () => {
  const header = (authorization: string) => ({ portal: 'billing', headers: { authorization } });

  it.each([
    ['no headers at all', { portal: 'billing' }],
    ['no Authorization header', { portal: 'billing', headers: {} }],
    ['an empty Authorization header', header('')],
    ['a bearer with no token', header('Bearer ')],
    ['a non-bearer scheme', header('Basic abc123')],
    ['garbage in place of a token', header('Bearer not.a.token')],
  ])('rejects %s', async (_label, request) => {
    await expect(buildGuard().canActivate(contextWith(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a valid token sent without the Bearer scheme', async () => {
    const token = await signAccessToken(CLAIMS, 'billing', KEYS);
    await expect(buildGuard().canActivate(contextWith(header(token)))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token signed with another key', async () => {
    const foreign = await signAccessToken(CLAIMS, 'billing', OTHER_KEYS);
    await expect(buildGuard().canActivate(contextWith(bearer(foreign)))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects another portal’s token: a studio token on a billing request', async () => {
    const studio = await signAccessToken(CLAIMS, 'studio', KEYS);
    await expect(buildGuard().canActivate(contextWith(bearer(studio, 'billing')))).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(buildGuard().canActivate(contextWith(bearer(studio, 'studio')))).resolves.toBe(true);
  });

  it('rejects a request with no portal, even with a good token', async () => {
    const token = await signAccessToken(CLAIMS, 'billing', KEYS);
    await expect(
      buildGuard().canActivate(contextWith({ headers: { authorization: `Bearer ${token}` } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('says nothing about why, in any of them', async () => {
    const studio = await signAccessToken(CLAIMS, 'studio', KEYS);
    const errors = await Promise.all(
      [{ portal: 'billing' }, bearer('not.a.token'), bearer(studio)].map((req) =>
        buildGuard()
          .canActivate(contextWith(req))
          .catch((e: UnauthorizedException) => e.message),
      ),
    );
    expect(new Set(errors).size).toBe(1);
  });
});

describe('JwtAuthGuard credential paths', () => {
  it('does not accept the refresh token as a bearer credential', async () => {
    const refresh = await signRefreshToken(CLAIMS, KEYS);
    await expect(buildGuard().canActivate(contextWith(bearer(refresh)))).rejects.toThrow(UnauthorizedException);
  });

  it('ignores a cookie entirely, so the refresh token is never ambient authority', async () => {
    const refresh = await signRefreshToken(CLAIMS, KEYS);
    const access = await signAccessToken(CLAIMS, 'billing', KEYS);

    await expect(
      buildGuard().canActivate(contextWith({ portal: 'billing', cookies: { [REFRESH_COOKIE_NAME]: refresh } })),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      buildGuard().canActivate(contextWith({ portal: 'billing', cookies: { session: access } })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
