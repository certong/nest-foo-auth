import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, KEY_LOCKED, KEY_REJECTED } from './auth.service';
import { hashPassword } from './password';
import { TOKEN_KEYS } from './token-keys';

const META: RequestMeta = { portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' };
const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const OTHER_ID = 'a3f1c2d4-0000-4000-8000-000000000002';
const KEY = '042719';

interface User {
  id: string;
  email: string;
}

interface Door {
  accountId: string | null;
  keyHash: string | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCount: number;
}

/**
 * A real in-memory account_pin row plus an account table, rather than a
 * call-recording mock: what these tests care about is the state a sequence of
 * requests leaves behind, which a mock that only remembers its arguments cannot
 * show. updateMany honours its where-clause so the compare-and-swap in
 * recordKeyFailure is genuinely exercised.
 */
async function buildService(
  overrides: Partial<Door> = {},
  users: User[] = [{ id: USER_ID, email: 'admin@example.com' }],
) {
  const door: Door = {
    accountId: USER_ID,
    keyHash: await hashPassword(KEY),
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCount: 0,
    ...overrides,
  };

  const withUser = () => ({
    ...door,
    account: users.find((u) => u.id === door.accountId) ?? null,
  });

  const matches = (where: Record<string, unknown>) =>
    (['failedAttempts', 'lockoutCount', 'accountId'] as const).every(
      (field) => where[field] === undefined || where[field] === door[field],
    );

  const accountPin = {
    upsert: () => Promise.resolve(withUser()),
    findUnique: () => Promise.resolve(withUser()),
    update: ({ data }: { data: Partial<Door> }) => {
      Object.assign(door, data);
      return Promise.resolve(withUser());
    },
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Partial<Door> }) => {
      if (!matches(where)) return Promise.resolve({ count: 0 });
      Object.assign(door, data);
      return Promise.resolve({ count: 1 });
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: { accountPin, account: {} } },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record: () => Promise.resolve() } },
    ],
  }).compile();

  return { service: moduleRef.get<AuthService>(AuthService), door };
}

async function bodyOf(run: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run;
  } catch (error) {
    return (error as { getResponse(): Record<string, unknown> }).getResponse();
  }
  throw new Error('expected a rejection, got a resolution');
}

async function statusOf(run: Promise<unknown>): Promise<number> {
  try {
    await run;
  } catch (error) {
    return (error as { getStatus(): number }).getStatus();
  }
  throw new Error('expected a rejection, got a resolution');
}

describe('AuthService.validateKey — the happy path', () => {
  it('returns the claims of the account the door points at', async () => {
    const { service } = await buildService();

    await expect(service.validateKey(KEY, META)).resolves.toEqual({
      id: USER_ID,
      email: 'admin@example.com',
      sid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('works with several accounts in the table', async () => {
    // The whole point of moving the key off account. The previous design
    // refused to serve at all once a second account existed.
    const { service } = await buildService({}, [
      { id: USER_ID, email: 'admin@example.com' },
      { id: OTHER_ID, email: 'second@example.com' },
      { id: 'third', email: 'third@example.com' },
    ]);

    await expect(service.validateKey(KEY, META)).resolves.toMatchObject({ id: USER_ID });
  });

  it('resets attempts, lockout count and the lock on success', async () => {
    // Everything, not just the attempt counter: leaving keyLockoutCount behind
    // would have the next lockout resume the old schedule, so a key typed
    // correctly for months still locks for an hour on its first slip.
    const { service, door } = await buildService({
      failedAttempts: 3,
      lockoutCount: 4,
      lockedUntil: new Date(Date.now() - 1000),
    });

    await service.validateKey(KEY, META);

    expect(door.failedAttempts).toBe(0);
    expect(door.lockoutCount).toBe(0);
    expect(door.lockedUntil).toBeNull();
  });
});

describe('AuthService.validateKey — counting failures', () => {
  it('rejects a wrong key with the attempts that remain', async () => {
    const { service } = await buildService();

    expect(await bodyOf(service.validateKey('000000', META))).toMatchObject({
      message: KEY_REJECTED,
      attemptsRemaining: 4,
    });
  });

  it('never answers without attemptsRemaining, whatever the reason', async () => {
    // Asserted with toEqual, not toMatchObject. An earlier version omitted this
    // field wherever there was no counter to read, which made a misconfigured
    // deployment a shorter body than a wrong key — distinguishable on the first
    // request, no countdown needed. toMatchObject is exactly what let that
    // through.
    const full = {
      statusCode: 401,
      error: 'Unauthorized',
      message: KEY_REJECTED,
      attemptsRemaining: 4,
    };

    expect(await bodyOf((await buildService()).service.validateKey('000000', META))).toEqual(full);
    expect(
      await bodyOf((await buildService({ keyHash: null, accountId: null })).service.validateKey(KEY, META)),
    ).toEqual(full);
    expect(
      await bodyOf((await buildService({ accountId: 'deleted' })).service.validateKey(KEY, META)),
    ).toEqual(full);
  });

  it('increments exactly once per request', async () => {
    // The frontend posts this unauthenticated precisely so its refresh-and-retry
    // path cannot double-post; the server must not undo that by double-counting.
    const { service, door } = await buildService();

    await bodyOf(service.validateKey('000000', META));
    await bodyOf(service.validateKey('000001', META));
    const third = await bodyOf(service.validateKey('000002', META));

    expect(door.failedAttempts).toBe(3);
    expect(third).toMatchObject({ attemptsRemaining: 2 });
  });

  it('counts down 4,3,2,1,0 and then locks', async () => {
    const { service, door } = await buildService();

    const seen: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      seen.push((await bodyOf(service.validateKey('000000', META))).attemptsRemaining);
    }

    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(door.lockoutCount).toBe(1);
    expect(door.lockedUntil).toBeInstanceOf(Date);
    // Zeroed at lock time so the lock expiring hands back a full budget rather
    // than a single attempt that immediately re-locks.
    expect(door.failedAttempts).toBe(0);
  });
});

describe('AuthService.validateKey — while locked', () => {
  it('answers 429 with the seconds left', async () => {
    const locked = { lockedUntil: new Date(Date.now() + 120_000), lockoutCount: 2 };

    expect(await statusOf((await buildService(locked)).service.validateKey(KEY, META))).toBe(429);
    const body = await bodyOf((await buildService(locked)).service.validateKey(KEY, META));
    expect(body).toMatchObject({ message: KEY_LOCKED });
    expect(body.retryAfter).toBeGreaterThan(115);
    expect(body.retryAfter).toBeLessThanOrEqual(120);
  });

  it('does not consume an attempt or extend the lock', async () => {
    const lockedUntil = new Date(Date.now() + 120_000);
    const { service, door } = await buildService({ lockedUntil, lockoutCount: 1 });

    await bodyOf(service.validateKey('000000', META));
    await bodyOf(service.validateKey('000000', META));

    expect(door.failedAttempts).toBe(0);
    expect(door.lockoutCount).toBe(1);
    expect(door.lockedUntil).toBe(lockedUntil);
  });

  it('rejects the correct key too — the lock is not a wrong-key filter', async () => {
    const { service } = await buildService({ lockedUntil: new Date(Date.now() + 60_000) });

    expect(await statusOf(service.validateKey(KEY, META))).toBe(429);
  });

  it('lets attempts resume once the lock has expired', async () => {
    const { service } = await buildService({
      lockedUntil: new Date(Date.now() - 1000),
      lockoutCount: 1,
    });

    await expect(service.validateKey(KEY, META)).resolves.toMatchObject({ id: USER_ID });
  });
});

describe('AuthService.validateKey — the backoff doubles', () => {
  const secondsUntil = (at: Date | null) => Math.round((at!.getTime() - Date.now()) / 1000);

  it('locks the second offence for twice as long as the first', async () => {
    const { service, door } = await buildService({ failedAttempts: 4, lockoutCount: 1 });

    await bodyOf(service.validateKey('000000', META));

    expect(secondsUntil(door.lockedUntil)).toBeGreaterThan(115);
    expect(secondsUntil(door.lockedUntil)).toBeLessThanOrEqual(120);
    expect(door.lockoutCount).toBe(2);
  });

  it('caps the schedule at an hour', async () => {
    const { service, door } = await buildService({ failedAttempts: 4, lockoutCount: 30 });

    await bodyOf(service.validateKey('000000', META));

    expect(secondsUntil(door.lockedUntil)).toBeGreaterThan(3595);
    expect(secondsUntil(door.lockedUntil)).toBeLessThanOrEqual(3600);
  });

  it('serves one lockout per five failures even when requests race', async () => {
    // Two fifth failures arriving together used to both read lockout_count as
    // zero, both write a sixty-second lock, and advance the exponent twice for
    // one lockout actually served. The compare-and-swap lets only one win.
    const { service, door } = await buildService({ failedAttempts: 4 });

    await Promise.all([
      bodyOf(service.validateKey('000000', META)),
      bodyOf(service.validateKey('000001', META)),
    ]);

    expect(door.lockoutCount).toBe(1);
    expect(secondsUntil(door.lockedUntil)).toBeLessThanOrEqual(60);
  });
});

describe('AuthService.validateKey — when no key is configured', () => {
  const unkeyed = { keyHash: null, accountId: null };

  it('still spends verify time', async () => {
    // Without burning the Argon2 cost, "is a PIN configured on this
    // deployment?" is answerable with a stopwatch even though the bodies match.
    const { service } = await buildService(unkeyed);

    const started = performance.now();
    await bodyOf(service.validateKey(KEY, META));
    expect(performance.now() - started).toBeGreaterThan(5);
  });

  it('counts down and locks exactly like a wrong key', async () => {
    // A single-response check passes even for an implementation that returns a
    // constant. Only the sequence proves the counters really run — and a
    // countdown that stood still would answer the same question the matching
    // bodies are there to hide.
    const { service, door } = await buildService(unkeyed);

    const seen: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      seen.push((await bodyOf(service.validateKey(KEY, META))).attemptsRemaining);
    }

    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(door.lockoutCount).toBe(1);
    expect(await statusOf(service.validateKey(KEY, META))).toBe(429);
  });

  it('treats a door pointing at a deleted account as no key at all', async () => {
    // Unreachable while the account_pin_pairing CHECK holds, but a corrupted
    // row must fail closed rather than 500.
    const { service } = await buildService({ accountId: 'no-such-user' });

    expect(await statusOf(service.validateKey(KEY, META))).toBe(401);
  });
});
