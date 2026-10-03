import { hashPassword } from '../src/auth/password';

export const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
export const EMAIL = 'admin@example.com';
export const PASSWORD = 's3cret-password';

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
}

/**
 * A PrismaService stand-in for endpoint suites: a staff account and a client
 * account (both with PASSWORD), a door that matches nothing, and an auth_event
 * table that records what was written — honouring the once-per-(sid, portal)
 * rule for portal_entry the way the partial unique index does, so a suite can
 * reason about rows, not calls. `accounts` is live: a suite can disable one or
 * change its type mid-test.
 */
export async function fakePrisma() {
  const passwordHash = await hashPassword(PASSWORD);
  const accounts: Row[] = [
    { id: USER_ID, email: EMAIL, passwordHash, accountType: 'staff', clientId: null, disabledAt: null },
    { id: CLIENT_USER_ID, email: CLIENT_EMAIL, passwordHash, accountType: 'client', clientId: CLIENT_ID, disabledAt: null },
  ];
  const events: Record<string, unknown>[] = [];
  const findUnique = vi.fn(({ where }: { where: { email?: string; id?: string } }) =>
    Promise.resolve(
      accounts.find((a) => (where.email !== undefined ? a.email === where.email : a.id === where.id)) ?? null,
    ),
  );

  const prisma = {
    account: { findUnique },
    accountPin: { updateMany: () => Promise.resolve({ count: 0 }) },
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
  return { prisma, events, findUnique, accounts };
}
