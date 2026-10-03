import { hashPassword } from '../src/auth/password';

export const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
export const EMAIL = 'admin@example.com';
export const PASSWORD = 's3cret-password';

/**
 * A PrismaService stand-in for endpoint suites: one account, a door that matches
 * nothing, and an auth_event table that records what was written — including
 * honouring the once-per-(sid, portal) rule for portal_entry the way the
 * partial unique index does, so a suite can reason about rows, not calls.
 */
export async function fakePrisma() {
  const passwordHash = await hashPassword(PASSWORD);
  const events: Record<string, unknown>[] = [];
  const findUnique = vi.fn(({ where }: { where: { email: string } }) =>
    Promise.resolve(where.email === EMAIL ? { id: USER_ID, email: EMAIL, passwordHash } : null),
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
  return { prisma, events, findUnique };
}
