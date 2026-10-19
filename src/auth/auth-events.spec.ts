import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { AuthEventInput, RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { PinLockout } from './pin-lockout';
import { TOKEN_KEYS } from './token-keys';

/**
 * What AuthService writes to auth_event, and — as much as what it writes —
 * that writing never changes what a request answers.
 */

const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const EMAIL = 'admin@example.com';
const PASSWORD = 's3cret-password';
const PIN = '042719';
const META: RequestMeta = { portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' };
const STUDIO: RequestMeta = { ...META, portal: 'studio' };

async function build(options: { recorder?: 'ok' | 'throws'; holder?: Record<string, unknown> } = {}) {
  const passwordHash = await hashPassword(PASSWORD);
  const pin = { accountId: USER_ID, pinHash: await hashPassword(PIN) };
  const user = { id: USER_ID, email: EMAIL, passwordHash, accountType: 'staff', clientId: null, disabledAt: null, pin, ...options.holder };

  const recorded: AuthEventInput[][] = [];
  const record = vi.fn((events: AuthEventInput[]) => {
    recorded.push(events);
    // The real service swallows its own errors; 'throws' proves the caller
    // would survive even if it did not.
    return options.recorder === 'throws' ? Promise.reject(new Error('log down')) : Promise.resolve();
  });

  const prisma = {
    account: {
      findUnique: ({ where }: { where: { email?: string; id?: string } }) =>
        Promise.resolve(where.email === EMAIL || where.id === USER_ID ? user : null),
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      PinLockout,
      { provide: PrismaService, useValue: prisma },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record } },
    ],
  }).compile();

  return { service: moduleRef.get(AuthService), recorded, record };
}

async function failureOf(run: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await run;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected a rejection');
}

const allEvents = (recorded: AuthEventInput[][]) => recorded.flat();

/**
 * There was a 'password sign-in' block here. Password sign-in is retired at
 * both portals, so login_failed and a login_success with method 'password' are
 * no longer reachable — nothing writes them. The facts that were not really
 * about passwords (a fresh sid per sign-in, the portal recorded, an answer
 * unchanged by a failing log write, no credential or token in any row) moved
 * into 'PIN sign-in' below, which is the only door left.
 *
 * AuthEventKind still declares login_failed, and auth_event's CHECK still
 * accepts it: rows written before the retirement are still in the table and
 * still have to read back.
 */

describe('PIN sign-in', () => {
  it('writes login_success with method pin', async () => {
    const { service, recorded } = await build();
    const claims = await service.validatePin(EMAIL, PIN, STUDIO);

    expect(recorded[0].map((e) => [e.kind, e.method ?? null, e.sid])).toEqual([
      ['login_success', 'pin', claims.sid],
      ['portal_entry', null, claims.sid],
    ]);
  });

  it('mints a different sid for every sign-in', async () => {
    const { service } = await build();
    const a = await service.validatePin(EMAIL, PIN, STUDIO);
    const b = await service.validatePin(EMAIL, PIN, STUDIO);
    expect(a.sid).not.toBe(b.sid);
  });

  it('records the portal the sign-in came from', async () => {
    const { service, recorded } = await build();
    await service.validatePin(EMAIL, PIN, STUDIO);
    expect(recorded[0].map((e) => e.portal)).toEqual(['studio', 'studio']);
  });

  it('gives the same 401 when the log write fails, and still signs in on success', async () => {
    const healthy = await build();
    const broken = await build({ recorder: 'throws' });

    // A throwing recorder breaks the real service's contract on purpose:
    // AuthService must still answer exactly as it would with a healthy log.
    const a = await failureOf(healthy.service.validatePin(EMAIL, '000000', STUDIO));
    const b = await failureOf(broken.service.validatePin(EMAIL, '000000', STUDIO));
    expect(b).toEqual(a);
    await expect(broken.service.validatePin(EMAIL, PIN, STUDIO)).resolves.toMatchObject({ id: USER_ID });
  });

  it('writes key_failed, naming the account, for a wrong PIN', async () => {
    const { service, recorded } = await build();
    await failureOf(service.validatePin(EMAIL, '000000', META));

    expect(allEvents(recorded)).toEqual([
      { kind: 'key_failed', method: 'pin', accountId: USER_ID, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('writes key_failed with no account for an unknown email', async () => {
    const { service, recorded } = await build();
    await failureOf(service.validatePin('nobody@example.com', PIN, META));

    expect(allEvents(recorded)).toEqual([
      { kind: 'key_failed', method: 'pin', accountId: null, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('writes key_failed, naming the account, when it has no PIN', async () => {
    const { service, recorded } = await build({ holder: { pin: null } });
    await failureOf(service.validatePin(EMAIL, PIN, META));

    expect(allEvents(recorded)).toMatchObject([{ kind: 'key_failed', accountId: USER_ID }]);
  });

  it('writes key_locked for the failure that starts a lockout, instead of key_failed', async () => {
    const { service, recorded } = await build();
    for (let i = 0; i < 5; i += 1) {
      await failureOf(service.validatePin(EMAIL, '000000', META));
    }
    expect(allEvents(recorded).map((e) => e.kind)).toEqual([
      'key_failed',
      'key_failed',
      'key_failed',
      'key_failed',
      'key_locked',
    ]);
  });

  it('writes nothing for a request refused while locked', async () => {
    const { service, recorded } = await build();
    for (let i = 0; i < 5; i += 1) {
      await failureOf(service.validatePin(EMAIL, '000000', META));
    }
    recorded.length = 0;

    const refused = await failureOf(service.validatePin(EMAIL, PIN, META));

    expect(refused.status).toBe(429);
    expect(recorded).toHaveLength(0);
  });

  it('never puts the typed email or the PIN in any event', async () => {
    const { service, recorded } = await build();
    await service.validatePin(EMAIL, PIN, STUDIO);
    await failureOf(service.validatePin(EMAIL, '987654', STUDIO));
    await failureOf(service.validatePin('typed-by-someone@example.com', '135792', STUDIO));

    const serialised = JSON.stringify(allEvents(recorded));
    expect(serialised).not.toContain(EMAIL);
    expect(serialised).not.toContain('typed-by-someone');
    expect(serialised).not.toContain(PIN);
    expect(serialised).not.toContain('987654');
    expect(serialised).not.toContain('135792');
  });

  it('never puts a token in any event', async () => {
    const { service, recorded } = await build();
    const claims = await service.validatePin(EMAIL, PIN, STUDIO);
    await service.refresh(await service.createRefreshToken(claims), STUDIO);

    expect(JSON.stringify(allEvents(recorded))).not.toMatch(/eyJ/); // no JWT
  });
});

describe('PIN sign-in and account types', () => {
  it('treats a disabled account as a wrong PIN: counted, never let in', async () => {
    const { service, recorded } = await build({ holder: { disabledAt: new Date() } });
    const refused = await failureOf(service.validatePin(EMAIL, PIN, STUDIO));

    expect(refused).toEqual({ status: 401, body: expect.objectContaining({ attemptsRemaining: 4 }) });
    expect(allEvents(recorded).map((e) => e.kind)).toEqual(['key_failed']);
  });

  it('refuses a client at billing with portal_denied, after the PIN is verified', async () => {
    const { service, recorded } = await build({ holder: { accountType: 'client', clientId: 42 } });
    const refused = await failureOf(service.validatePin(EMAIL, PIN, META));

    expect(refused.status).toBe(403);
    expect(allEvents(recorded)).toEqual([
      expect.objectContaining({ kind: 'portal_denied', method: 'pin', accountId: USER_ID, portal: 'billing' }),
    ]);
  });
});

describe('refresh', () => {
  it('writes portal_entry for the requesting portal, under the session’s sid', async () => {
    const { service, recorded } = await build();
    const claims = await service.validatePin(EMAIL, PIN, META);
    recorded.length = 0;

    await service.refresh(await service.createRefreshToken(claims), STUDIO);

    expect(allEvents(recorded)).toEqual([
      { kind: 'portal_entry', accountId: USER_ID, sid: claims.sid, portal: 'studio', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('asks for portal_entry on every refresh, leaving "once" to the database', async () => {
    // Not deduplicated in memory: that would be per-instance and lost on
    // deploy. The partial unique index is the rule (see the DB suite).
    const { service, record } = await build();
    const claims = await service.validatePin(EMAIL, PIN, META);
    const token = await service.createRefreshToken(claims);
    record.mockClear();

    await service.refresh(token, META);
    await service.refresh(token, META);

    expect(record).toHaveBeenCalledTimes(2);
  });

  it('writes nothing for a refresh it refuses', async () => {
    const { service, recorded } = await build();
    await failureOf(service.refresh('not.a.token', META));
    await failureOf(service.refresh(undefined, META));
    expect(recorded).toHaveLength(0);
  });
});

describe('logout', () => {
  it('writes logout with the session’s account and sid', async () => {
    const { service, recorded } = await build();
    const claims = await service.validatePin(EMAIL, PIN, META);
    recorded.length = 0;

    await service.logout(await service.createRefreshToken(claims), STUDIO);

    expect(allEvents(recorded)).toEqual([
      { kind: 'logout', accountId: USER_ID, sid: claims.sid, portal: 'studio', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('writes nothing, and does not throw, with no cookie or a bad one', async () => {
    const { service, recorded } = await build();
    await expect(service.logout(undefined, META)).resolves.toBeUndefined();
    await expect(service.logout('not.a.token', META)).resolves.toBeUndefined();
    expect(recorded).toHaveLength(0);
  });
});
