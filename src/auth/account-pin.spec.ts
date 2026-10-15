import { clearAccountPin, setAccountPin } from './account-pin';
import { verifyPassword } from './password';

const PIN = '042719';

interface PinRow {
  accountId: string;
  pinHash: string;
}

/** An account table and a real in-memory account_pin table, keyed by account. */
function fakePrisma(users: Array<{ id: string; email: string; accountType: string }>, pins: PinRow[] = []) {
  const table = new Map(pins.map((p) => [p.accountId, { ...p }]));
  return {
    table,
    prisma: {
      account: {
        findUnique: ({ where }: { where: { email: string } }) =>
          Promise.resolve(users.find((u) => u.email === where.email) ?? null),
      },
      accountPin: {
        upsert: ({ where, create, update }: { where: { accountId: string }; create: PinRow; update: Partial<PinRow> }) => {
          const existing = table.get(where.accountId);
          const row = existing === undefined ? { ...create } : Object.assign(existing, update);
          table.set(where.accountId, row);
          return Promise.resolve(row);
        },
        deleteMany: ({ where }: { where: { accountId: string } }) =>
          Promise.resolve({ count: table.delete(where.accountId) ? 1 : 0 }),
      },
    },
  };
}

const ADMIN = { id: 'u1', email: 'admin@example.com', accountType: 'staff' };
const SECOND = { id: 'u2', email: 'second@example.com', accountType: 'staff' };
const CLIENT = { id: 'u9', email: 'owner@client.example', accountType: 'client' };

describe('setAccountPin', () => {
  it('stores an Argon2 hash, never the digits', async () => {
    const { prisma, table } = fakePrisma([ADMIN]);
    await setAccountPin(prisma as never, 'admin@example.com', PIN);

    const { pinHash } = table.get(ADMIN.id)!;
    expect(pinHash).not.toBe(PIN);
    expect(pinHash).toMatch(/^\$argon2/);
    await expect(verifyPassword(pinHash, PIN)).resolves.toBe(true);
  });

  it('gives each account its own PIN', async () => {
    const { prisma, table } = fakePrisma([ADMIN, SECOND]);
    await setAccountPin(prisma as never, ADMIN.email, PIN);
    await setAccountPin(prisma as never, SECOND.email, '999888');

    await expect(verifyPassword(table.get(ADMIN.id)!.pinHash, PIN)).resolves.toBe(true);
    await expect(verifyPassword(table.get(SECOND.id)!.pinHash, '999888')).resolves.toBe(true);
  });

  it('replaces an account’s existing PIN', async () => {
    const { prisma, table } = fakePrisma([ADMIN], [{ accountId: ADMIN.id, pinHash: 'old' }]);
    await setAccountPin(prisma as never, ADMIN.email, '999888');

    expect(table.size).toBe(1);
    await expect(verifyPassword(table.get(ADMIN.id)!.pinHash, '999888')).resolves.toBe(true);
  });

  it('gives a PIN to a client account too, since studio is PIN-only', async () => {
    const { prisma, table } = fakePrisma([CLIENT]);
    await setAccountPin(prisma as never, CLIENT.email, PIN);

    expect(table.has(CLIENT.id)).toBe(true);
  });

  it('finds the account however the email was typed', async () => {
    const { prisma, table } = fakePrisma([ADMIN]);
    await expect(setAccountPin(prisma as never, '  Admin@Example.com ', PIN)).resolves.toEqual({
      email: ADMIN.email,
    });
    expect(table.has(ADMIN.id)).toBe(true);
  });

  it('refuses a PIN that is not exactly six digits', async () => {
    const { prisma, table } = fakePrisma([ADMIN]);

    for (const bad of ['12345', '1234567', 'abcdef', '', '04271a']) {
      await expect(setAccountPin(prisma as never, ADMIN.email, bad)).rejects.toThrow(/six digits/);
    }
    expect(table.size).toBe(0);
  });

  it('refuses an email with no account rather than creating one', async () => {
    // Unlike seed:admin this must not upsert: a mistyped address would hand a
    // PIN to a login nobody meant to exist.
    const { prisma, table } = fakePrisma([ADMIN]);

    await expect(setAccountPin(prisma as never, 'ghost@example.com', PIN)).rejects.toThrow(/no account/i);
    expect(table.size).toBe(0);
  });
});

describe('clearAccountPin', () => {
  it('removes only the named account’s PIN', async () => {
    const { prisma, table } = fakePrisma(
      [ADMIN, SECOND],
      [
        { accountId: ADMIN.id, pinHash: 'a' },
        { accountId: SECOND.id, pinHash: 'b' },
      ],
    );

    await expect(clearAccountPin(prisma as never, ADMIN.email)).resolves.toEqual({
      email: ADMIN.email,
      removed: true,
    });
    expect([...table.keys()]).toEqual([SECOND.id]);
  });

  it('says so when there was no PIN to remove', async () => {
    const { prisma } = fakePrisma([ADMIN]);
    await expect(clearAccountPin(prisma as never, ADMIN.email)).resolves.toEqual({
      email: ADMIN.email,
      removed: false,
    });
  });

  it('refuses an email with no account', async () => {
    const { prisma } = fakePrisma([ADMIN]);
    await expect(clearAccountPin(prisma as never, 'ghost@example.com')).rejects.toThrow(/no account/i);
  });
});
