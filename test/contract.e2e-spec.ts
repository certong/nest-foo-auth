import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { REFRESH_COOKIE_NAME } from '../src/auth/session-cookie';
import { createTestApp } from './create-test-app';
import { CLIENT_EMAIL, CLIENT_ID, EMAIL, PASSWORD, USER_ID, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN, STUDIO_ORIGIN, TEST_ISSUER, testKeys } from './test-keys';

/**
 * The contract billing and studio build their verify-only guards against
 * (spec section 8), exercised end to end: the service listens on a real port,
 * and the verifier below fetches its JWKS over HTTP exactly as a product
 * backend will. If this suite and the spec disagree, the spec is wrong.
 */

let app: INestApplication;
let jwksUrl: URL;

beforeAll(async () => {
  const { prisma } = await fakePrisma();
  app = await createTestApp((builder) =>
    builder.overrideProvider(PrismaService).useValue(prisma).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }),
  );
  await app.listen(0);
  jwksUrl = new URL(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/.well-known/jwks.json`);
});

afterAll(async () => {
  await app.close();
});

/** The reference verifier from the spec, verbatim apart from configuration. */
function productBackendVerifier(portal: 'billing' | 'studio') {
  const jwks = createRemoteJWKSet(jwksUrl);
  return async (
    token: string,
  ): Promise<{ sub: string; email: string; sid: string; account_type: string; client_id?: number }> => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ['ES256'],
        issuer: TEST_ISSUER,
        audience: portal,
      });
      if (payload.typ !== 'access') throw new Error('typ');
      const { sub, email, sid } = payload;
      for (const value of [sub, email, sid]) {
        if (typeof value !== 'string' || value.length === 0) throw new Error('claims');
      }
      const accountType = payload.account_type;
      if (accountType !== 'staff' && accountType !== 'client') throw new Error('account_type');
      if (accountType === 'client') {
        const clientId = payload.client_id;
        if (typeof clientId !== 'number' || !Number.isInteger(clientId) || clientId <= 0) throw new Error('client_id');
        return { sub: sub as string, email: email as string, sid: sid as string, account_type: accountType, client_id: clientId };
      }
      if (portal === 'billing' && accountType !== 'staff') throw new Error('staff only');
      return { sub: sub as string, email: email as string, sid: sid as string, account_type: accountType };
    } catch {
      throw new UnauthorizedException();
    }
  };
}

function cookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[];
  return raw.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))!.split(';')[0];
}

async function signIn(origin: string, email = EMAIL) {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password: PASSWORD })
    .expect(200);
  return { accessToken: res.body.accessToken as string, cookie: cookieFrom(res) };
}

async function refresh(origin: string, cookie: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/refresh')
    .set('Origin', origin)
    .set('Cookie', cookie)
    .send({})
    .expect(200);
  return res.body.accessToken;
}

const sidOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid;

describe('what a product backend accepts', () => {
  it('billing accepts a billing token and reads sub, email and sid', async () => {
    const { accessToken } = await signIn(BILLING_ORIGIN);
    const claims = await productBackendVerifier('billing')(accessToken);

    expect(claims).toEqual({
      sub: USER_ID,
      email: EMAIL,
      sid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      account_type: 'staff',
    });
  });

  it('studio accepts a studio token', async () => {
    const { accessToken } = await signIn(STUDIO_ORIGIN);
    await expect(productBackendVerifier('studio')(accessToken)).resolves.toMatchObject({ sub: USER_ID });
  });

  it('studio reads a client token’s account_type and client_id, which it filters data by', async () => {
    const { accessToken } = await signIn(STUDIO_ORIGIN, CLIENT_EMAIL);
    await expect(productBackendVerifier('studio')(accessToken)).resolves.toMatchObject({
      account_type: 'client',
      client_id: CLIENT_ID,
    });
  });
});

describe('audience separation', () => {
  it('billing rejects a studio token', async () => {
    const { accessToken } = await signIn(STUDIO_ORIGIN);
    await expect(productBackendVerifier('billing')(accessToken)).rejects.toThrow(UnauthorizedException);
  });

  it('studio rejects a billing token', async () => {
    const { accessToken } = await signIn(BILLING_ORIGIN);
    await expect(productBackendVerifier('studio')(accessToken)).rejects.toThrow(UnauthorizedException);
  });

  it('neither accepts the refresh token', async () => {
    const { cookie } = await signIn(BILLING_ORIGIN);
    const refreshToken = cookie.split('=')[1];

    await expect(productBackendVerifier('billing')(refreshToken)).rejects.toThrow(UnauthorizedException);
    await expect(productBackendVerifier('studio')(refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  it('neither accepts a token signed by a key the JWKS does not hold', async () => {
    const { signAccessToken } = await import('../src/auth/session-token');
    const foreign = await signAccessToken({ id: USER_ID, email: EMAIL, sid: 'x', accountType: 'staff', clientId: null }, 'billing', await testKeys('rogue'));

    await expect(productBackendVerifier('billing')(foreign)).rejects.toThrow(UnauthorizedException);
  });

  it('this service’s own /me refuses a studio token sent from the billing origin', async () => {
    const { accessToken } = await signIn(STUDIO_ORIGIN);
    const server = app.getHttpServer();

    await request(server).get('/api/me').set('Origin', BILLING_ORIGIN).set('Authorization', `Bearer ${accessToken}`).expect(401);
    await request(server).get('/api/me').set('Origin', STUDIO_ORIGIN).set('Authorization', `Bearer ${accessToken}`).expect(200);
  });
});

describe('single sign-on', () => {
  it('a sign-in at billing lets studio refresh into a studio token for the same session', async () => {
    const { accessToken: billingToken, cookie } = await signIn(BILLING_ORIGIN);
    const studioToken = await refresh(STUDIO_ORIGIN, cookie);

    await expect(productBackendVerifier('studio')(studioToken)).resolves.toMatchObject({ sub: USER_ID });
    await expect(productBackendVerifier('billing')(studioToken)).rejects.toThrow(UnauthorizedException);
    expect(sidOf(studioToken)).toBe(sidOf(billingToken));
  });

  it('logout from either portal ends the session for both, since there is one cookie', async () => {
    const { cookie } = await signIn(BILLING_ORIGIN);
    const out = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', STUDIO_ORIGIN)
      .set('Cookie', cookie)
      .send({})
      .expect(204);
    const cleared = cookieFrom(out);

    for (const origin of [BILLING_ORIGIN, STUDIO_ORIGIN]) {
      await request(app.getHttpServer()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', cleared).send({}).expect(401);
    }
  });
});
