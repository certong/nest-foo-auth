import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { AuthEventInput, RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password';
import { TOKEN_KEYS } from './token-keys';

/**
 * What AuthService writes to auth_event, and — as much as what it writes —
 * that writing never changes what a request answers.
 */

const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const EMAIL = 'admin@example.com';
const PASSWORD = 's3cret-password';
const KEY = '042719';
const META: RequestMeta = { portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' };
const STUDIO: RequestMeta = { ...META, portal: 'studio' };

interface Door {
  accountId: string | null;
  keyHash: string | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCount: number;
}

async function build(options: { door?: Partial<Door>; recorder?: 'ok' | 'throws'; holder?: Record<string, unknown> } = {}) {
  const passwordHash = await hashPassword(PASSWORD);
  const user = { id: USER_ID, email: EMAIL, passwordHash, accountType: 'staff', clientId: null, disabledAt: null, ...options.holder };
  const door: Door = {
    accountId: USER_ID,
    keyHash: await hashPassword(KEY),
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCount: 0,
    ...options.door,
  };
  const withUser = () => ({ ...door, account: door.accountId === USER_ID ? user : null });

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
    accountPin: {
      upsert: () => Promise.resolve(withUser()),
      findUnique: () => Promise.resolve(withUser()),
      update: ({ data }: { data: Partial<Door> }) => Promise.resolve(Object.assign(door, data)),
      updateMany: ({ where, data }: { where: Record<string, unknown>; data: Partial<Door> }) => {
        const matches = (['failedAttempts', 'lockoutCount', 'accountId'] as const).every(
          (f) => where[f] === undefined || where[f] === door[f],
        );
        if (!matches) return Promise.resolve({ count: 0 });
        Object.assign(door, data);
        return Promise.resolve({ count: 1 });
      },
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record } },
    ],
  }).compile();

  return { service: moduleRef.get(AuthService), recorded, record, door };
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

describe('password sign-in', () => {
  it('writes login_success and the first portal_entry, together, under a new sid', async () => {
    const { service, recorded } = await build();
    const claims = await service.validateCredentials(EMAIL, PASSWORD, META);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual([
      { kind: 'login_success', method: 'password', accountId: USER_ID, sid: claims.sid, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
      { kind: 'portal_entry', accountId: USER_ID, sid: claims.sid, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('mints a different sid for every sign-in', async () => {
    const { service } = await build();
    const a = await service.validateCredentials(EMAIL, PASSWORD, META);
    const b = await service.validateCredentials(EMAIL, PASSWORD, META);
    expect(a.sid).not.toBe(b.sid);
  });

  it('records the portal the sign-in came from', async () => {
    const { service, recorded } = await build();
    await service.validateCredentials(EMAIL, PASSWORD, STUDIO);
    expect(recorded[0].map((e) => e.portal)).toEqual(['studio', 'studio']);
  });

  it('writes login_failed with the account for a wrong password', async () => {
    const { service, recorded } = await build();
    await failureOf(service.validateCredentials(EMAIL, 'wrong', META));

    expect(allEvents(recorded)).toEqual([
      { kind: 'login_failed', method: 'password', accountId: USER_ID, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('writes login_failed with no account for an unknown email, and never the email itself', async () => {
    const { service, recorded } = await build();
    await failureOf(service.validateCredentials('typo-or-password@example.com', 'wrong', META));

    const events = allEvents(recorded);
    expect(events).toEqual([
      { kind: 'login_failed', method: 'password', accountId: null, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
    expect(JSON.stringify(events)).not.toContain('typo-or-password');
  });

  it('answers unknown email and wrong password identically, with the log in place', async () => {
    const { service } = await build();
    const unknown = await failureOf(service.validateCredentials('nobody@example.com', 'wrong', META));
    const wrong = await failureOf(service.validateCredentials(EMAIL, 'wrong', META));
    expect(unknown).toEqual(wrong);
  });

  it('gives the same 401 when the log write fails, and still signs in on success', async () => {
    const healthy = await build();
    const broken = await build({ recorder: 'throws' });

    // A throwing recorder breaks the real service's contract on purpose:
    // AuthService must still answer exactly as it would with a healthy log.
    const a = await failureOf(healthy.service.validateCredentials(EMAIL, 'wrong', META));
    const b = await failureOf(broken.service.validateCredentials(EMAIL, 'wrong', META));
    expect(b).toEqual(a);
    await expect(broken.service.validateCredentials(EMAIL, PASSWORD, META)).resolves.toMatchObject({ id: USER_ID });
  });

  it('never puts a password or token in any event', async () => {
    const { service, recorded } = await build();
    await service.validateCredentials(EMAIL, PASSWORD, META);
    await failureOf(service.validateCredentials(EMAIL, 'hunter2-wrong', META));
    const claims = await service.validateCredentials(EMAIL, PASSWORD, META);
    await service.refresh(await service.createRefreshToken(claims), META);

    const serialised = JSON.stringify(allEvents(recorded));
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toMatch(/eyJ/); // no JWT
  });
});

describe('PIN sign-in', () => {
  it('writes login_success with method pin', async () => {
    const { service, recorded } = await build();
    const claims = await service.validateKey(KEY, META);

    expect(recorded[0].map((e) => [e.kind, e.method ?? null, e.sid])).toEqual([
      ['login_success', 'pin', claims.sid],
      ['portal_entry', null, claims.sid],
    ]);
  });

  it('writes key_failed, naming the door holder, for a wrong key', async () => {
    const { service, recorded } = await build();
    await failureOf(service.validateKey('000000', META));

    expect(allEvents(recorded)).toEqual([
      { kind: 'key_failed', method: 'pin', accountId: USER_ID, portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' },
    ]);
  });

  it('writes key_failed with no account when no key is configured', async () => {
    const { service, recorded } = await build({ door: { keyHash: null, accountId: null } });
    await failureOf(service.validateKey(KEY, META));

    expect(allEvents(recorded)).toMatchObject([{ kind: 'key_failed', accountId: null }]);
  });

  it('writes key_locked for the failure that starts a lockout, instead of key_failed', async () => {
    const { service, recorded } = await build();
    for (let i = 0; i < 5; i += 1) {
      await failureOf(service.validateKey('000000', META));
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
    const { service, recorded } = await build({ door: { lockedUntil: new Date(Date.now() + 60_000) } });
    const refused = await failureOf(service.validateKey(KEY, META));

    expect(refused.status).toBe(429);
    expect(recorded).toHaveLength(0);
  });

  it('records only key_failed for the loser of a race to lock', async () => {
    // Two fifth failures together: one CAS wins and locks, the other cannot
    // know whether it would have, so it does not claim key_locked.
    const { service, recorded } = await build({ door: { failedAttempts: 4 } });
    await Promise.all([failureOf(service.validateKey('000000', META)), failureOf(service.validateKey('000001', META))]);

    expect(allEvents(recorded).map((e) => e.kind).sort()).toEqual(['key_failed', 'key_locked']);
  });
});

describe('PIN sign-in and account types', () => {
  it('treats a disabled door holder as no key: counted, never let in', async () => {
    const { service, recorded, door } = await build({ holder: { disabledAt: new Date() } });
    const refused = await failureOf(service.validateKey(KEY, META));

    expect(refused.status).toBe(401);
    expect(door.failedAttempts).toBe(1);
    expect(allEvents(recorded).map((e) => e.kind)).toEqual(['key_failed']);
  });

  it('refuses a client holder at billing with portal_denied, if the database was edited by hand', async () => {
    const { service, recorded } = await build({ holder: { accountType: 'client', clientId: 42 } });
    const refused = await failureOf(service.validateKey(KEY, META));

    expect(refused.status).toBe(403);
    expect(allEvents(recorded)).toEqual([
      expect.objectContaining({ kind: 'portal_denied', method: 'pin', accountId: USER_ID, portal: 'billing' }),
    ]);
  });
});

describe('refresh', () => {
  it('writes portal_entry for the requesting portal, under the session’s sid', async () => {
    const { service, recorded } = await build();
    const claims = await service.validateCredentials(EMAIL, PASSWORD, META);
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
    const claims = await service.validateCredentials(EMAIL, PASSWORD, META);
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
    const claims = await service.validateCredentials(EMAIL, PASSWORD, META);
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
