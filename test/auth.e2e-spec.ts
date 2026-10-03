import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { REFRESH_COOKIE_NAME } from '../src/auth/session-cookie';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './create-test-app';
import { BILLING_ORIGIN } from './test-keys';

const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const PASSWORD = 's3cret-password';

let app: INestApplication;

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);

  app = await createTestApp((builder) =>
    builder
      .overrideProvider(PrismaService)
      .useValue({
        account: {
          findUnique: ({ where }: { where: { email: string } }) =>
            Promise.resolve(
              where.email === 'admin@example.com'
                ? { id: USER_ID, email: 'admin@example.com', passwordHash }
                : null,
            ),
        },
        // Signing in clears any PIN lockout on this account's door; this suite
        // has no door, so the update matches nothing.
        accountPin: { updateMany: () => Promise.resolve({ count: 0 }) },
        authEvent: { createMany: () => Promise.resolve({ count: 0 }) },
      })
      // These cases exercise login behaviour, not the rate limit, and there are
      // more than five of them from one address. auth-throttle.e2e-spec.ts owns
      // the limit itself.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true }),
  );
});

afterAll(async () => {
  await app.close();
});

function refreshCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

/** Signs in and returns both halves of the session. */
async function signIn(): Promise<{ accessToken: string; cookie: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .set('Origin', BILLING_ORIGIN)
    .send({ email: 'admin@example.com', password: PASSWORD })
    .expect(200);
  return { accessToken: res.body.accessToken, cookie: refreshCookie(res) as string };
}

describe('POST /api/auth/login', () => {
  it('returns an access token and the user', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: 'admin@example.com', password: PASSWORD })
      .expect(200);

    expect(res.body.user).toEqual({ id: USER_ID, email: 'admin@example.com' });
    expect(typeof res.body.accessToken).toBe('string');
  });

  it('puts the refresh token in an httpOnly cookie and never in the body', async () => {
    // The whole point of the split: script can read the access token because it
    // has to attach it, and cannot read the token that mints more.
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: 'admin@example.com', password: PASSWORD })
      .expect(200);

    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
  });

  it('accepts the email in any case', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: '  ADMIN@Example.com ', password: PASSWORD })
      .expect(200);
  });

  it('rejects a wrong password with 401 and sets no cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: 'admin@example.com', password: 'wrong' })
      .expect(401);

    expect(res.body.message).toBe('Invalid email or password');
    expect(refreshCookie(res)).toBeUndefined();
  });

  it('answers an unknown email identically to a wrong password', async () => {
    const unknown = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: 'nobody@example.com', password: 'wrong' })
      .expect(401);

    expect(unknown.body.message).toBe('Invalid email or password');
  });

  it('rejects a malformed email with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: 'not-an-email', password: PASSWORD })
      .expect(400);
  });

  it('rejects an unexpected body key with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: 'admin@example.com', password: PASSWORD, role: 'admin' })
      .expect(400);
  });
});

describe('GET /api/me', () => {
  it('returns the signed-in user when the bearer token is presented', async () => {
    const { accessToken } = await signIn();

    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Origin', BILLING_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toEqual({ id: USER_ID, email: 'admin@example.com' });
  });

  it('is 401 with no credential', async () => {
    await request(app.getHttpServer()).get('/api/me').set('Origin', BILLING_ORIGIN).expect(401);
  });

  it('is 401 when only the refresh cookie is presented', async () => {
    // The refresh cookie is not ambient authority. If it were, every request
    // would carry implicit credentials again and CSRF would be back.
    const { cookie } = await signIn();

    await request(app.getHttpServer()).get('/api/me').set('Origin', BILLING_ORIGIN).set('Cookie', cookie).expect(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('mints a working access token from the refresh cookie', async () => {
    const { cookie } = await signIn();

    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Cookie', cookie)
      .expect(200);

    expect(typeof res.body.accessToken).toBe('string');

    await request(app.getHttpServer())
      .get('/api/me')
      .set('Origin', BILLING_ORIGIN)
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
  });

  it('is 401 without the cookie', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(401);
  });

  it('does not accept an access token in place of the refresh cookie', async () => {
    const { accessToken } = await signIn();

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${accessToken}`)
      .expect(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('returns 204 and expires the cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(204);

    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    // Express clears by setting an already-past expiry.
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('works without a valid session, so an expired tab can still sign out', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(204);
  });

  it('stops the session being extended, which is all logout can guarantee', async () => {
    // A signed JWT cannot be recalled, so the access token already issued keeps
    // working until it expires. What logout guarantees is that no new one can
    // be minted from the discarded cookie.
    const { cookie } = await signIn();

    const out = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Cookie', cookie)
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Cookie', refreshCookie(out) as string)
      .expect(401);
  });
});
