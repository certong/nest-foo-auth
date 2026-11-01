import { Test } from '@nestjs/testing';
import { testKeys } from '../../test/test-keys';
import { RequestMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, PIN_REJECTED } from './auth.service';
import { hashPassword } from './password';
import { PIN_LOCKED, PIN_MAX_ATTEMPTS, PinLockout } from './pin-lockout';
import { TOKEN_KEYS } from './token-keys';

/**
 * FA-25: billing signs in with a PIN and nothing else.
 *
 * Billing is staff-only and single-operator, so a PIN there can only belong to
 * one account and the portal does not ask its operator to type an address
 * first. Studio is not single-operator and must still send an email.
 *
 * The email-bearing path is covered by auth-pin.service.spec.ts and is not
 * repeated here; what these pin down is the resolution, and that nothing about
 * it weakens the lockout.
 */
const BILLING: RequestMeta = { portal: 'billing', ip: '203.0.113.7', userAgent: 'vitest' };
const STUDIO: RequestMeta = { ...BILLING, portal: 'studio' };

const OPERATOR_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const OPERATOR = 'owner@example.com';
const PIN = '042719';

interface Operator {
  id: string;
  email: string;
  accountType: string;
  clientId: number | null;
  disabledAt: Date | null;
  pinHash: string;
}

/**
 * A service over a given set of accounts.
 *
 * `findMany` is modelled rather than stubbed flat, because the whole point of
 * the resolution is the filter it applies: staff, not disabled, holding a PIN.
 * A stub that ignored the `where` would pass whatever the filter said.
 */
async function buildService(operators: Operator[]) {
  const findMany = vi.fn(({ where, take }: { where: Record<string, unknown>; take?: number }) => {
    const matched = operators
      .filter((o) => o.accountType === where.accountType)
      .filter((o) => (where.disabledAt === null ? o.disabledAt === null : true))
      .filter((o) => (where.pin ? o.pinHash !== '' : true))
      .map((o) => ({ email: o.email }));
    return Promise.resolve(take === undefined ? matched : matched.slice(0, take));
  });

  const findUnique = vi.fn(({ where }: { where: { email?: string } }) => {
    const row = operators.find((o) => o.email === where.email);
    return Promise.resolve(
      row === undefined
        ? null
        : {
            id: row.id,
            email: row.email,
            accountType: row.accountType,
            clientId: row.clientId,
            disabledAt: row.disabledAt,
            pin: row.pinHash === '' ? null : { accountId: row.id, pinHash: row.pinHash },
          },
    );
  });

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      PinLockout,
      { provide: PrismaService, useValue: { account: { findMany, findUnique } } },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record: () => Promise.resolve() } },
    ],
  }).compile();

  return { service: moduleRef.get(AuthService), findMany, findUnique };
}

async function operator(over: Partial<Operator> = {}): Promise<Operator> {
  return {
    id: OPERATOR_ID,
    email: OPERATOR,
    accountType: 'staff',
    clientId: null,
    disabledAt: null,
    pinHash: await hashPassword(PIN),
    ...over,
  };
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

describe('validatePin — billing, with no email', () => {
  it('signs the one operator in from the PIN alone', async () => {
    const { service } = await buildService([await operator()]);

    await expect(service.validatePin(undefined, PIN, BILLING)).resolves.toEqual({
      id: OPERATOR_ID,
      email: OPERATOR,
      sid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountType: 'staff',
      clientId: null,
    });
  });

  /** Resolved by lookup, not by trying the PIN against every account: one
   * Argon2 verify, and no undefined answer when two accounts share six digits. */
  it('resolves the operator by filter — staff, enabled, holding a PIN', async () => {
    const { service, findMany } = await buildService([await operator()]);

    await service.validatePin(undefined, PIN, BILLING);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountType: 'staff', disabledAt: null, pin: { isNot: null } },
        take: 2,
      }),
    );
  });

  it('is the same session a typed email would have produced', async () => {
    const { service } = await buildService([await operator()]);

    const withEmail = await service.validatePin(OPERATOR, PIN, BILLING);
    const without = await service.validatePin(undefined, PIN, BILLING);

    expect({ ...without, sid: null }).toEqual({ ...withEmail, sid: null });
  });

  it('rejects a wrong PIN with the usual body', async () => {
    const { service } = await buildService([await operator()]);

    const { status, body } = await failureOf(service.validatePin(undefined, '999999', BILLING));

    expect(status).toBe(401);
    expect(body).toMatchObject({ message: PIN_REJECTED, attemptsRemaining: PIN_MAX_ATTEMPTS - 1 });
  });
});

describe('validatePin — billing, when no single operator can be resolved', () => {
  /** The case that says the single-operator assumption has stopped holding.
   * Refused rather than resolved: picking one of two humans is not something a
   * sign-in gets to guess at. */
  it('refuses when two staff accounts hold PINs', async () => {
    const { service } = await buildService([
      await operator(),
      await operator({ id: 'a3f1c2d4-0000-4000-8000-000000000002', email: 'second@example.com' }),
    ]);

    const { status, body } = await failureOf(service.validatePin(undefined, PIN, BILLING));

    expect(status).toBe(401);
    expect(body).toMatchObject({ message: PIN_REJECTED });
  });

  it('refuses when nobody holds a PIN', async () => {
    const { service } = await buildService([await operator({ pinHash: '' })]);

    const { status } = await failureOf(service.validatePin(undefined, PIN, BILLING));

    expect(status).toBe(401);
  });

  /** A disabled operator is excluded by the filter, so it lands on the same
   * refusal as having no operator at all — never a different answer that would
   * say "that account exists but is switched off". */
  it('refuses when the only operator is disabled', async () => {
    const { service } = await buildService([await operator({ disabledAt: new Date('2026-01-01') })]);

    const { status, body } = await failureOf(service.validatePin(undefined, PIN, BILLING));

    expect(status).toBe(401);
    expect(body).toMatchObject({ message: PIN_REJECTED });
  });

  /** Indistinguishable from a wrong PIN, down to the field. `pinRejected`
   * requires `attemptsRemaining` precisely so no rejection can be told apart by
   * the shape of its body on the first request. */
  it('answers in the same shape a wrong PIN does', async () => {
    const { service } = await buildService([]);

    const { body } = await failureOf(service.validatePin(undefined, PIN, BILLING));

    expect(body).toHaveProperty('attemptsRemaining', PIN_MAX_ATTEMPTS - 1);
  });
});

describe('validatePin — the email is only optional for billing', () => {
  it('refuses a studio request that sent no email', async () => {
    const { service } = await buildService([await operator()]);

    const { status, body } = await failureOf(service.validatePin(undefined, PIN, STUDIO));

    expect(status).toBe(401);
    expect(body).toMatchObject({ message: PIN_REJECTED });
  });

  /** Studio must not be able to reach an account without naming it, even when
   * the PIN is the operator's real one. */
  it('does not resolve an operator for studio even with the right PIN', async () => {
    const { service, findMany } = await buildService([await operator()]);

    await failureOf(service.validatePin(undefined, PIN, STUDIO));

    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('validatePin — the lockout is not weakened by resolving', () => {
  /** The attempt is taken against the resolved account, so PIN-only guessing
   * spends the same five tries an email-bearing caller would. */
  it('locks the operator out after five wrong PINs with no email', async () => {
    const { service } = await buildService([await operator()]);

    for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
      await failureOf(service.validatePin(undefined, '999999', BILLING));
    }

    const { status, body } = await failureOf(service.validatePin(undefined, PIN, BILLING));
    expect(status).toBe(429);
    expect(body).toMatchObject({ message: PIN_LOCKED });
  });

  /** A caller who cannot name an account must not be able to spend the
   * operator's budget: the unresolved path has a key of its own. Otherwise
   * anyone could lock the operator out of their own portal without ever
   * knowing an email. */
  it('cannot lock the operator out through the unresolvable path', async () => {
    const { service } = await buildService([
      await operator(),
      await operator({ id: 'a3f1c2d4-0000-4000-8000-000000000002', email: 'second@example.com' }),
    ]);

    // Five refusals on the "two operators" path...
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
      await failureOf(service.validatePin(undefined, PIN, BILLING));
    }

    // ...leave the named account's own budget untouched.
    const { status, body } = await failureOf(service.validatePin(OPERATOR, '999999', BILLING));
    expect(status).toBe(401);
    expect(body).toMatchObject({ attemptsRemaining: PIN_MAX_ATTEMPTS - 1 });
  });

  it('locks the unresolvable path itself once it has been hammered', async () => {
    const { service } = await buildService([]);

    for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
      await failureOf(service.validatePin(undefined, PIN, BILLING));
    }

    const { status } = await failureOf(service.validatePin(undefined, PIN, BILLING));
    expect(status).toBe(429);
  });
});
