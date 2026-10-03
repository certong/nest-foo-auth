import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { REFRESH_COOKIE_NAME } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { EMAIL, PASSWORD, USER_ID, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN, STUDIO_ORIGIN } from './test-keys';

/**
 * The login log through the HTTP surface. The fake table applies the
 * once-per-(sid, portal) rule the way the partial unique index does; the DB
 * suite proves the index itself.
 */

let app: INestApplication;
let events: Record<string, unknown>[];

beforeEach(async () => {
  const fake = await fakePrisma();
  events = fake.events;
  app = await createTestApp((builder) =>
    builder.overrideProvider(PrismaService).useValue(fake.prisma).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }),
  );
});

afterEach(async () => {
  await app.close();
});

const server = () => app.getHttpServer();

async function signIn(origin: string): Promise<string> {
  const res = await request(server()).post('/api/auth/login').set('Origin', origin).set('User-Agent', 'e2e-browser').send({ email: EMAIL, password: PASSWORD }).expect(200);
  const raw = res.headers['set-cookie'] as unknown as string[];
  return raw.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))!.split(';')[0];
}

const refresh = (origin: string, cookie: string) =>
  request(server()).post('/api/auth/refresh').set('Origin', origin).set('Cookie', cookie).send({}).expect(200);

const portalEntries = () => events.filter((e) => e.kind === 'portal_entry').map((e) => e.portal);

describe('portal_entry: once per session per portal', () => {
  it('a sign-in records the portal it came from', async () => {
    await signIn(BILLING_ORIGIN);
    expect(events.map((e) => e.kind)).toEqual(['login_success', 'portal_entry']);
    expect(portalEntries()).toEqual(['billing']);
  });

  it('repeated refreshes from the same portal add nothing', async () => {
    const cookie = await signIn(BILLING_ORIGIN);
    for (let i = 0; i < 5; i += 1) {
      await refresh(BILLING_ORIGIN, cookie);
    }
    expect(portalEntries()).toEqual(['billing']);
  });

  it('the first refresh from the other portal adds exactly one more', async () => {
    const cookie = await signIn(BILLING_ORIGIN);
    await refresh(STUDIO_ORIGIN, cookie);
    await refresh(STUDIO_ORIGIN, cookie);
    await refresh(BILLING_ORIGIN, cookie);

    expect(portalEntries()).toEqual(['billing', 'studio']);
  });

  it('a second sign-in is a new session with its own entries', async () => {
    await signIn(BILLING_ORIGIN);
    await signIn(BILLING_ORIGIN);
    const sids = new Set(events.filter((e) => e.kind === 'portal_entry').map((e) => e.sid));
    expect(sids.size).toBe(2);
  });
});

describe('the rows themselves', () => {
  it('carry the account, sid, portal and user agent, and tie login, entries and logout together', async () => {
    const cookie = await signIn(BILLING_ORIGIN);
    await refresh(STUDIO_ORIGIN, cookie);
    await request(server()).post('/api/auth/logout').set('Origin', STUDIO_ORIGIN).set('Cookie', cookie).send({}).expect(204);

    expect(events.map((e) => [e.kind, e.portal])).toEqual([
      ['login_success', 'billing'],
      ['portal_entry', 'billing'],
      ['portal_entry', 'studio'],
      ['logout', 'studio'],
    ]);
    expect(new Set(events.map((e) => e.sid)).size).toBe(1);
    expect(events.every((e) => e.accountId === USER_ID)).toBe(true);
    expect(events[0]).toMatchObject({ method: 'password', userAgent: 'e2e-browser' });
    expect(typeof events[0].ip).toBe('string');
  });

  it('a failed sign-in for an unknown email stores no account and no email', async () => {
    await request(server()).post('/api/auth/login').set('Origin', BILLING_ORIGIN).send({ email: 'typed-a-password@example.com', password: 'x' }).expect(401);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'login_failed', accountId: null, method: 'password', portal: 'billing' });
    expect(JSON.stringify(events)).not.toContain('typed-a-password');
  });

  it('a refused origin writes nothing at all', async () => {
    await request(server()).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: EMAIL, password: 'x' }).expect(403);
    expect(events).toHaveLength(0);
  });
});
