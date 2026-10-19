import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { REFRESH_COOKIE_NAME } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { CLIENT_EMAIL, CLIENT_USER_ID, EMAIL, PASSWORD, PIN, USER_ID, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN, STUDIO_ORIGIN } from './test-keys';

/**
 * POST /api/auth/pin over HTTP (FA-24): email + six-digit PIN, the only way
 * into studio. The per-IP throttle is switched off here so the per-email
 * lockout can be seen on its own; auth-throttle.e2e-spec.ts covers the throttle.
 */

let app: INestApplication;
let fake: Awaited<ReturnType<typeof fakePrisma>>;

beforeEach(async () => {
  fake = await fakePrisma();
  app = await createTestApp((builder) =>
    builder.overrideProvider(PrismaService).useValue(fake.prisma).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }),
  );
});

afterEach(async () => {
  await app.close();
});

const pinLogin = (email: string, pin: string, origin = STUDIO_ORIGIN) =>
  request(app.getHttpServer()).post('/api/auth/pin').set('Origin', origin).send({ email, pin });

const cookieOf = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`)) ?? '';

describe('POST /api/auth/pin', () => {
  it('signs in with the right email and PIN at studio: 200, a studio token, and the cookie', async () => {
    const res = await pinLogin(EMAIL, PIN).expect(200);

    expect(res.body).toEqual({
      accessToken: expect.any(String),
      user: { id: USER_ID, email: EMAIL, accountType: 'staff' },
    });
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.aud).toBe('studio');
    expect(cookieOf(res)).toMatch(/HttpOnly/i);
  });

  it('takes the email in any case, with spaces around it', async () => {
    await pinLogin('  Admin@Example.COM ', PIN).expect(200);
  });

  it('answers an unknown email, no PIN, a disabled account and a wrong PIN with the same bytes', async () => {
    const unknown = await pinLogin('nobody@example.com', PIN).expect(401);

    fake.accounts.find((a) => a.id === CLIENT_USER_ID)!.pin = null;
    const noPin = await pinLogin(CLIENT_EMAIL, PIN).expect(401);

    const wrong = await pinLogin(EMAIL, '000000').expect(401);

    // Re-enabled with a fresh budget, so the disabled case starts from the same
    // count as the others.
    await pinLogin(EMAIL, PIN).expect(200);
    fake.accounts.find((a) => a.id === USER_ID)!.disabledAt = new Date();
    const disabled = await pinLogin(EMAIL, PIN).expect(401);

    expect(unknown.text).toBe(
      JSON.stringify({ statusCode: 401, error: 'Unauthorized', message: 'Invalid email or PIN', attemptsRemaining: 4 }),
    );
    for (const res of [noPin, wrong, disabled]) {
      expect(res.text).toBe(unknown.text);
      expect(cookieOf(res)).toBe('');
    }
  });

  it('locks an email for fifteen minutes after five wrong tries', async () => {
    for (let i = 0; i < 5; i += 1) {
      await pinLogin(EMAIL, '000000').expect(401);
    }
    const locked = await pinLogin(EMAIL, PIN).expect(429);

    expect(locked.body).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too many attempts', retryAfter: 900 });
  });

  it('locks an unknown email exactly the same way', async () => {
    for (let i = 0; i < 5; i += 1) {
      await pinLogin('nobody@example.com', PIN).expect(401);
    }
    const locked = await pinLogin('nobody@example.com', PIN).expect(429);
    expect(locked.body.retryAfter).toBe(900);
  });

  it('refuses a client at billing with 403 and portal_denied', async () => {
    const res = await pinLogin(CLIENT_EMAIL, PIN, BILLING_ORIGIN).expect(403);
    expect(res.body.message).toBe('This account cannot sign in to this portal');
    expect(fake.events.at(-1)).toMatchObject({ kind: 'portal_denied', method: 'pin', portal: 'billing' });
  });

  it('rejects a malformed body with 400, before any lookup', async () => {
    fake.findUnique.mockClear();
    await pinLogin(EMAIL, '12345').expect(400);
    await pinLogin('not-an-email', PIN).expect(400);
    await request(app.getHttpServer()).post('/api/auth/pin').set('Origin', STUDIO_ORIGIN).send({ key: PIN }).expect(400);
    expect(fake.findUnique).not.toHaveBeenCalled();
  });

  it('stores neither the typed email nor the PIN in any event', async () => {
    await pinLogin(EMAIL, PIN).expect(200);
    await pinLogin(EMAIL, '987654').expect(401);
    await pinLogin('typed@example.com', '135792').expect(401);

    const serialised = JSON.stringify(fake.events);
    for (const secret of [EMAIL, 'typed@example.com', PIN, '987654', '135792']) {
      expect(serialised).not.toContain(secret);
    }
    expect(fake.events.map((e) => e.kind)).toEqual(['login_success', 'portal_entry', 'key_failed', 'key_failed']);
  });
});

describe('studio is PIN-only', () => {
  it('refuses a password sign-in at studio with 403, before any lookup', async () => {
    fake.findUnique.mockClear();
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', STUDIO_ORIGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(403);

    expect(res.body).toEqual({ statusCode: 403, error: 'Forbidden', message: 'Use PIN sign-in for this portal' });
    expect(cookieOf(res)).toBe('');
    expect(fake.findUnique).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
  });

  it('still lets a staff password session at billing refresh into studio', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Origin', STUDIO_ORIGIN)
      .set('Cookie', cookieOf(login).split(';')[0])
      .send({})
      .expect(200);
  });
});

describe('POST /api/auth/key', () => {
  it('is gone', async () => {
    await request(app.getHttpServer()).post('/api/auth/key').set('Origin', BILLING_ORIGIN).send({ key: PIN }).expect(404);
  });
});

/**
 * FA-25: billing signs in with a PIN and nothing else.
 *
 * Over HTTP, because the rule spans three layers that unit tests see
 * separately — PortalGuard turning an Origin into a portal, the DTO letting the
 * field be absent, and AuthService deciding whether that absence is allowed.
 */
describe('POST /api/auth/pin — no email, from billing', () => {
  const pinOnly = (pin: string, origin = BILLING_ORIGIN) =>
    request(app.getHttpServer()).post('/api/auth/pin').set('Origin', origin).send({ pin });

  it('signs the operator in and issues a billing token with the cookie', async () => {
    const res = await pinOnly(PIN).expect(200);

    expect(res.body).toEqual({
      accessToken: expect.any(String),
      user: { id: USER_ID, email: EMAIL, accountType: 'staff' },
    });
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.aud).toBe('billing');
    expect(cookieOf(res)).not.toBe('');
  });

  /** The same door, so the same answer: a body with the email and one without
   * must be indistinguishable once signed in. */
  it('returns what the email-bearing request returns', async () => {
    const withEmail = await pinLogin(EMAIL, PIN, BILLING_ORIGIN).expect(200);
    const without = await pinOnly(PIN).expect(200);

    expect(without.body.user).toEqual(withEmail.body.user);
  });

  it('rejects a wrong PIN with the usual 401', async () => {
    const res = await pinOnly('999999').expect(401);
    expect(res.body).toMatchObject({ attemptsRemaining: expect.any(Number) });
  });

  /** Studio has several accounts, so a PIN there names nobody. */
  it('refuses the same request from studio', async () => {
    await pinOnly(PIN, STUDIO_ORIGIN).expect(401);
  });

  /** A PIN is still six digits — dropping the email does not relax the rest. */
  it('still validates the PIN itself', async () => {
    await pinOnly('12345').expect(400);
  });

  /** Omitting the key is the only way to leave the email out; a blank one is a
   * malformed address and the DTO says so. */
  it('rejects a blank email rather than treating it as absent', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/pin')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: '', pin: PIN })
      .expect(400);
  });

  /** The single-operator assumption, made visible: with a second staff account
   * holding a PIN there is no one answer, and the request is refused rather
   * than resolved to a guess. */
  it('refuses once a second staff account holds a PIN', async () => {
    fake.accounts.push({
      id: '00000000-0000-4000-8000-0000000000ff',
      email: 'second@example.com',
      passwordHash: 'x',
      accountType: 'staff',
      clientId: null,
      disabledAt: null,
      pin: { accountId: '00000000-0000-4000-8000-0000000000ff', pinHash: 'x' },
    });

    await pinOnly(PIN).expect(401);
  });

  /** A client account with a PIN is not an operator: billing is staff-only, so
   * it must not make the resolution ambiguous. The fixture ships one. */
  it('is not confused by the client account that also holds a PIN', async () => {
    await pinOnly(PIN).expect(200);
  });
});
