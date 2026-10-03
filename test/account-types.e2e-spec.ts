import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { REFRESH_COOKIE_NAME } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { CLIENT_EMAIL, CLIENT_ID, CLIENT_USER_ID, EMAIL, PASSWORD, USER_ID, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN, STUDIO_ORIGIN } from './test-keys';

/**
 * Staff and client logins (account-types spec): billing is staff-only, studio
 * takes both, and the rule holds at every door — sign-in, refresh across
 * portals, and a login disabled mid-session.
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

const server = () => app.getHttpServer();
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());

function login(origin: string, email: string, password = PASSWORD) {
  return request(server()).post('/api/auth/login').set('Origin', origin).send({ email, password });
}

function cookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))?.split(';')[0] ?? '';
}

const refresh = (origin: string, cookie: string) =>
  request(server()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', cookie).send({});

describe('who may sign in where', () => {
  it('staff signs in to billing and to studio', async () => {
    await login(BILLING_ORIGIN, EMAIL).expect(200);
    await login(STUDIO_ORIGIN, EMAIL).expect(200);
  });

  it('a client signs in to studio, and its token says which client', async () => {
    const res = await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(200);

    expect(res.body.user).toEqual({ id: CLIENT_USER_ID, email: CLIENT_EMAIL, accountType: 'client', clientId: CLIENT_ID });
    expect(payloadOf(res.body.accessToken)).toMatchObject({ aud: 'studio', account_type: 'client', client_id: CLIENT_ID });
  });

  it('a staff token says staff and carries no client', async () => {
    const res = await login(BILLING_ORIGIN, EMAIL).expect(200);

    expect(res.body.user).toEqual({ id: USER_ID, email: EMAIL, accountType: 'staff' });
    const payload = payloadOf(res.body.accessToken);
    expect(payload.account_type).toBe('staff');
    expect(payload).not.toHaveProperty('client_id');
  });

  it('a client is refused at billing with 403, no cookie, and a portal_denied row', async () => {
    const res = await login(BILLING_ORIGIN, CLIENT_EMAIL).expect(403);

    expect(res.body.message).toBe('This account cannot sign in to this portal');
    expect(cookieOf(res)).toBe('');
    expect(fake.events).toEqual([
      expect.objectContaining({ kind: 'portal_denied', accountId: CLIENT_USER_ID, portal: 'billing', method: 'password' }),
    ]);
  });

  it('a client with the wrong password at billing gets the ordinary 401, not the 403', async () => {
    // The portal check runs only after the password: otherwise the 403 would
    // tell anyone that this email is a client account.
    const res = await login(BILLING_ORIGIN, CLIENT_EMAIL, 'wrong').expect(401);
    expect(res.body.message).toBe('Invalid email or password');
  });
});

describe('single sign-on does not leak billing to a client', () => {
  it('a client signed in at studio cannot refresh into a billing token', async () => {
    const cookie = cookieOf(await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(200));

    const denied = await refresh(BILLING_ORIGIN, cookie).expect(403);
    expect(denied.body).not.toHaveProperty('accessToken');
    expect(fake.events.filter((e) => e.kind === 'portal_entry').map((e) => e.portal)).toEqual(['studio']);
    expect(fake.events.at(-1)).toMatchObject({ kind: 'portal_denied', portal: 'billing', sid: expect.any(String) });

    // ...and the session is not harmed at studio.
    await refresh(STUDIO_ORIGIN, cookie).expect(200);
  });

  it('staff signed in at billing still refreshes into studio', async () => {
    const cookie = cookieOf(await login(BILLING_ORIGIN, EMAIL).expect(200));
    const res = await refresh(STUDIO_ORIGIN, cookie).expect(200);
    expect(payloadOf(res.body.accessToken)).toMatchObject({ aud: 'studio', account_type: 'staff' });
  });
});

describe('disabled logins', () => {
  const disable = (id: string) => {
    fake.accounts.find((a) => a.id === id)!.disabledAt = new Date();
  };

  it('cannot sign in, and look exactly like a wrong password', async () => {
    disable(CLIENT_USER_ID);
    const disabled = await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(401);
    const wrong = await login(STUDIO_ORIGIN, EMAIL, 'wrong').expect(401);
    expect(disabled.body).toEqual(wrong.body);
  });

  it('lose their open session at the next refresh', async () => {
    const cookie = cookieOf(await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(200));
    await refresh(STUDIO_ORIGIN, cookie).expect(200);

    disable(CLIENT_USER_ID);
    await refresh(STUDIO_ORIGIN, cookie).expect(401);
  });

  it('are refused at refresh once the account is gone altogether', async () => {
    const cookie = cookieOf(await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(200));
    fake.accounts.splice(fake.accounts.findIndex((a) => a.id === CLIENT_USER_ID), 1);
    await refresh(STUDIO_ORIGIN, cookie).expect(401);
  });
});

describe('a change of type or client ends the session', () => {
  it('refuses a refresh whose token no longer matches the account', async () => {
    // Re-scoping a live session silently would let a token minted for one
    // client keep working after the login was moved to another.
    const cookie = cookieOf(await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(200));
    fake.accounts.find((a) => a.id === CLIENT_USER_ID)!.clientId = 77;
    await refresh(STUDIO_ORIGIN, cookie).expect(401);
  });
});

describe('/me', () => {
  it('returns the account type and client for a client', async () => {
    const { accessToken } = (await login(STUDIO_ORIGIN, CLIENT_EMAIL).expect(200)).body;
    const res = await request(server())
      .get('/api/me')
      .set('Origin', STUDIO_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toEqual({ id: CLIENT_USER_ID, email: CLIENT_EMAIL, accountType: 'client', clientId: CLIENT_ID });
  });
});
