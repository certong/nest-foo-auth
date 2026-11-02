import * as argon2 from '@node-rs/argon2';
import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, PIN_LOCKED, PIN_REJECTED } from './auth.service';
import { PORTAL_DENIED } from './account-type';
import { hashPassword } from './password';
import { PIN_LOCKOUT_SECONDS, PinLockout } from './pin-lockout';
import { TOKEN_KEYS } from './token-keys';

// The real verify, wrapped so a test can count how many Argon2 verifies one
// request costs.
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const real = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...real, verify: vi.fn(real.verify) };
});

const STUDIO: RequestMeta = { portal: 'studio', ip: '203.0.113.7', userAgent: 'vitest' };
const BILLING: RequestMeta = { ...STUDIO, portal: 'billing' };
const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const EMAIL = 'admin@example.com';
const PIN = '042719';

interface Row {
  id: string;
  email: string;
  accountType: string;
  clientId: number | null;
  disabledAt: Date | null;
  pin: { accountId: string; pinHash: string } | null;
}

async function buildService(overrides: Partial<Row> = {}) {
  const row: Row = {
    id: USER_ID,
    email: EMAIL,
    accountType: 'staff',
    clientId: null,
    disabledAt: null,
    pin: { accountId: USER_ID, pinHash: await hashPassword(PIN) },
    ...overrides,
  };
  const findUnique = vi.fn(({ where }: { where: { email?: string } }) =>
    Promise.resolve(where.email === row.email ? row : null),
  );

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      PinLockout,
      { provide: PrismaService, useValue: { account: { findUnique } } },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record: () => Promise.resolve() } },
    ],
  }).compile();

  return { service: moduleRef.get(AuthService), findUnique };
}

async function failureOf(run: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await run;
  } catch (error) {
    const e = error as { getStatus(): number; getResponse(): Record<string, unknown> };
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected a rejection, got a resolution');
}

describe('AuthService.validatePin — the happy path', () => {
  it('returns the claims of the account the email names', async () => {
    const { service } = await buildService();

    await expect(service.validatePin(EMAIL, PIN, STUDIO)).resolves.toEqual({
      id: USER_ID,
      email: EMAIL,
      sid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountType: 'staff',
      clientId: null,
    });
  });

  it('looks the account up with its PIN, by the email it was given', async () => {
    const { service, findUnique } = await buildService();
    await service.validatePin(EMAIL, PIN, STUDIO);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: EMAIL }, include: { pin: true } });
  });

  it('lets a client into studio', async () => {
    const { service } = await buildService({ accountType: 'client', clientId: 42 });
    await expect(service.validatePin(EMAIL, PIN, STUDIO)).resolves.toMatchObject({ accountType: 'client', clientId: 42 });
  });

  it('lets staff into billing too', async () => {
    const { service } = await buildService();
    await expect(service.validatePin(EMAIL, PIN, BILLING)).resolves.toMatchObject({ id: USER_ID });
  });

  it('gives back the failures on success, so the next slip has a full budget', async () => {
    const { service } = await buildService();
    for (let i = 0; i < 3; i += 1) {
      await failureOf(service.validatePin(EMAIL, '000000', STUDIO));
    }
    await service.validatePin(EMAIL, PIN, STUDIO);

    expect((await failureOf(service.validatePin(EMAIL, '000000', STUDIO))).body.attemptsRemaining).toBe(4);
  });
});

describe('AuthService.validatePin — every failure looks the same', () => {
  const verify = vi.mocked(argon2.verify);

  const cases: [string, Partial<Row>, string, string][] = [
    ['an unknown email', {}, 'nobody@example.com', PIN],
    ['an account with no PIN', { pin: null }, EMAIL, PIN],
    ['a disabled account', { disabledAt: new Date() }, EMAIL, PIN],
    ['a wrong PIN', {}, EMAIL, '000000'],
  ];

  it.each(cases)('%s: the same 401 body, after exactly one Argon2 verify', async (_label, row, email, pin) => {
    const { service } = await buildService(row);
    // Builds the throwaway hash burnVerifyTime uses before counting, so only
    // the request's own verify is seen below.
    await failureOf(service.validatePin('warm-up@example.com', PIN, STUDIO));
    verify.mockClear();

    const failure = await failureOf(service.validatePin(email, pin, STUDIO));

    // toEqual, not toMatchObject: an extra or missing field is exactly the
    // difference that would tell these cases apart.
    expect(failure).toEqual({
      status: 401,
      body: { statusCode: 401, error: 'Unauthorized', message: PIN_REJECTED, attemptsRemaining: 4 },
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService.validatePin — the lockout', () => {
  it('locks the email after five wrong tries: 429 with retryAfter', async () => {
    const { service } = await buildService();
    const remaining: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      remaining.push((await failureOf(service.validatePin(EMAIL, '000000', STUDIO))).body.attemptsRemaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);

    const locked = await failureOf(service.validatePin(EMAIL, PIN, STUDIO));
    expect(locked).toEqual({
      status: 429,
      body: { statusCode: 429, error: 'Too Many Requests', message: PIN_LOCKED, retryAfter: PIN_LOCKOUT_SECONDS },
    });
  });

  it('locks an unknown email the same way', async () => {
    const { service } = await buildService();
    for (let i = 0; i < 5; i += 1) {
      await failureOf(service.validatePin('nobody@example.com', PIN, STUDIO));
    }
    expect((await failureOf(service.validatePin('nobody@example.com', PIN, STUDIO))).status).toBe(429);
  });

  it('refuses the right PIN too while locked, without verifying it', async () => {
    const verify = vi.mocked(argon2.verify);
    const { service } = await buildService();
    for (let i = 0; i < 5; i += 1) {
      await failureOf(service.validatePin(EMAIL, '000000', STUDIO));
    }
    verify.mockClear();

    expect((await failureOf(service.validatePin(EMAIL, PIN, STUDIO))).status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  });

  it('leaves other emails alone', async () => {
    const { service } = await buildService();
    for (let i = 0; i < 5; i += 1) {
      await failureOf(service.validatePin('nobody@example.com', PIN, STUDIO));
    }
    await expect(service.validatePin(EMAIL, PIN, STUDIO)).resolves.toMatchObject({ id: USER_ID });
  });

  // Until password sign-in was retired, a password at billing cleared this
  // lockout — proving the password was not the guessing the lockout exists to
  // stop. With the password gone there is no such proof left to offer, and
  // waiting out the fifteen minutes is the only way back in. That is a
  // deliberate narrowing, not an oversight: there is no override left for an
  // operator who locks themselves out of billing.
});

describe('AuthService.validatePin — portals', () => {
  it('refuses a client at billing with 403, after the PIN is verified', async () => {
    const { service } = await buildService({ accountType: 'client', clientId: 42 });
    const refused = await failureOf(service.validatePin(EMAIL, PIN, BILLING));

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ message: PORTAL_DENIED });
  });

  it('answers a client’s wrong PIN at billing with the ordinary 401', async () => {
    // The portal check comes after the PIN, so it cannot say "this is a client".
    const { service } = await buildService({ accountType: 'client', clientId: 42 });
    expect((await failureOf(service.validatePin(EMAIL, '000000', BILLING))).status).toBe(401);
  });
});
