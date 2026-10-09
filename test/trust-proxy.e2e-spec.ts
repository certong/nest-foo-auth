import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Express } from 'express';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { EMAIL, PASSWORD, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN } from './test-keys';

/**
 * TRUST_PROXY, through the app configureApp wires — the one setting whose being
 * wrong is invisible until it matters. Deployed behind a proxy without it, every
 * request appears to come from the proxy: the login throttle becomes one shared
 * global budget rather than one per client, and every auth_event row records the
 * proxy's address instead of the client's.
 *
 * Asserted on the auth_event row rather than on req.ip, because the row is what
 * an incident is actually read from.
 *
 * TRUST_PROXY is a *hop count*, not a boolean: it says how many proxies sit in
 * front of this service. Express walks that many entries right-to-left along
 * X-Forwarded-For and stops, so everything further left — whatever the client
 * itself sent — is ignored. The count has to match the deployment; FA-12 checks
 * it against a real auth_event row.
 */

const CLIENT_IP = '203.0.113.7';
const EDGE_IP = '198.51.100.4';
const SPOOFED_IP = '1.2.3.4';

let app: INestApplication;
let events: Record<string, unknown>[];

async function boot(env: Record<string, string> = {}): Promise<void> {
  const fake = await fakePrisma();
  events = fake.events;
  app = await createTestApp(
    (builder) =>
      builder
        .overrideProvider(PrismaService)
        .useValue(fake.prisma)
        .overrideGuard(ThrottlerGuard)
        .useValue({ canActivate: () => true }),
    env,
  );
}

/**
 * configureApp reads TRUST_PROXY from the environment and createTestApp assigns
 * into process.env, so a value set by one case would otherwise be inherited by
 * the next.
 */
beforeEach(() => {
  delete process.env.TRUST_PROXY;
});

afterEach(async () => {
  await app.close();
  delete process.env.TRUST_PROXY;
});

const signIn = (forwardedFor?: string) => {
  const req = request(app.getHttpServer()).post('/api/auth/login').set('Origin', BILLING_ORIGIN);
  if (forwardedFor !== undefined) {
    req.set('X-Forwarded-For', forwardedFor);
  }
  return req.send({ email: EMAIL, password: PASSWORD }).expect(200);
};

const loggedIp = () => events.find((e) => e.kind === 'login_success')!.ip;

const expressSetting = () => (app.getHttpAdapter().getInstance() as Express).get('trust proxy');

describe('TRUST_PROXY set', () => {
  it('logs the client address the proxy forwarded, not the proxy itself', async () => {
    // One proxy in front, which appends the address it accepted the connection
    // from. Without TRUST_PROXY this row would read ::ffff:127.0.0.1.
    await boot({ TRUST_PROXY: '1' });
    await signIn(CLIENT_IP);

    expect(loggedIp()).toBe(CLIENT_IP);
    expect(expressSetting()).toBe(1);
  });

  it('stops at the hop count, so a client cannot spoof its way past it', async () => {
    // The client sent an X-Forwarded-For of its own; the proxy appended the
    // address it really came from. One trusted hop means Express takes the
    // proxy's entry and never reaches the invented one.
    await boot({ TRUST_PROXY: '1' });
    await signIn(`${SPOOFED_IP}, ${CLIENT_IP}`);

    expect(loggedIp()).toBe(CLIENT_IP);
  });

  it('counts two hops when told two, so the edge proxy is not logged as the client', async () => {
    // Two proxies — a CDN in front of the platform router, say. Set to 1 this
    // would record the edge's address on every row; the number has to match
    // what is actually in front of the service.
    await boot({ TRUST_PROXY: '2' });
    await signIn(`${CLIENT_IP}, ${EDGE_IP}`);

    expect(loggedIp()).toBe(CLIENT_IP);
    expect(expressSetting()).toBe(2);
  });
});

describe('TRUST_PROXY unset', () => {
  it('leaves the Express setting alone', async () => {
    // Not `false` by way of `Number(undefined)`: configureApp must not call
    // set() at all, or Express's own default would be overwritten by an
    // accident of parsing.
    await boot();

    expect(expressSetting()).toBeFalsy();
  });

  it('ignores X-Forwarded-For and logs the address the connection came from', async () => {
    await boot();
    await signIn(CLIENT_IP);

    const ip = loggedIp();
    expect(ip).not.toBe(CLIENT_IP);
    expect(ip).toMatch(/127.0.0.1$|^::1$/);
  });
});
