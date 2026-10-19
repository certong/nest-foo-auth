import { hashPassword } from '../src/auth/password';

export const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
export const EMAIL = 'admin@example.com';
export const PASSWORD = 's3cret-password';
/** Both accounts' PIN (POST /auth/pin). */
export const PIN = '042719';

export const CLIENT_USER_ID = 'a3f1c2d4-0000-4000-8000-000000000042';
export const CLIENT_EMAIL = 'owner@client.example';
export const CLIENT_ID = 42;

interface Row {
  id: string;
  email: string;
  passwordHash: string;
  accountType: string;
  clientId: number | null;
  disabledAt: Date | null;
  pin: { accountId: string; pinHash: string } | null;
}

/**
 * A PrismaService stand-in for endpoint suites: a staff account and a client
 * account (both with PASSWORD and PIN), and an auth_event
 * table that records what was written — honouring the once-per-(sid, portal)
 * rule for portal_entry the way the partial unique index does, so a suite can
 * reason about rows, not calls. `accounts` is live: a suite can disable one,
 * change its type or remove its PIN mid-test.
 */
export async function fakePrisma() {
  const passwordHash = await hashPassword(PASSWORD);
  const pinHash = await hashPassword(PIN);
  const accounts: Row[] = [
    { id: USER_ID, email: EMAIL, passwordHash, accountType: 'staff', clientId: null, disabledAt: null, pin: { accountId: USER_ID, pinHash } },
    {
      id: CLIENT_USER_ID,
      email: CLIENT_EMAIL,
      passwordHash,
      accountType: 'client',
      clientId: CLIENT_ID,
      disabledAt: null,
      pin: { accountId: CLIENT_USER_ID, pinHash },
    },
  ];
  const events: Record<string, unknown>[] = [];
  const findUnique = vi.fn(({ where }: { where: { email?: string; id?: string } }) =>
    Promise.resolve(
      accounts.find((a) => (where.email !== undefined ? a.email === where.email : a.id === where.id)) ?? null,
    ),
  );

  /**
   * Billing's PIN-only sign-in resolves its one operator with this (FA-25).
   *
   * The `where` is honoured rather than ignored, because the filter IS the
   * behaviour under test: staff only, not disabled, holding a PIN. A fake that
   * returned every account would pass whether or not the service asked for the
   * right ones, and `accounts` is live, so a suite can disable the operator or
   * add a second one and see the resolution change.
   */
  const findMany = vi.fn(
    ({ where, take }: { where: { accountType?: string; disabledAt?: Date | null; pin?: unknown }; take?: number }) => {
      const matched = accounts
        .filter((a) => where.accountType === undefined || a.accountType === where.accountType)
        .filter((a) => where.disabledAt !== null || a.disabledAt === null)
        .filter((a) => where.pin === undefined || a.pin !== null)
        .map((a) => ({ email: a.email }));
      return Promise.resolve(take === undefined ? matched : matched.slice(0, take));
    },
  );

  const prisma = {
    account: { findUnique, findMany },
    authEvent: {
      createMany: ({ data }: { data: Record<string, unknown>[] }) => {
        let count = 0;
        for (const row of data) {
          const duplicate =
            row.kind === 'portal_entry' &&
            events.some((e) => e.kind === 'portal_entry' && e.sid === row.sid && e.portal === row.portal);
          if (!duplicate) {
            events.push(row);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
    },
    $executeRaw: () => Promise.resolve(0),
  };
  return { prisma, events, findUnique, findMany, accounts };
}
