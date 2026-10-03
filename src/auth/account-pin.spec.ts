import { clearAccountPin, accountPinHolder, setAccountPin } from './account-pin';
import { verifyPassword } from './password';

const KEY = '042719';
const USER_ID = 'u1';
const OTHER_ID = 'u2';

interface Door {
  accountId: string | null;
  keyHash: string | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  lockoutCount: number;
}

function fakePrisma(users: Array<{ id: string; email: string; accountType: string }>, door: Partial<Door> = {}) {
  const row: Door = {
    accountId: null,
    keyHash: null,
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCount: 0,
    ...door,
  };
  const withUser = () => ({ ...row, account: users.find((u) => u.id === row.accountId) ?? null });

  return {
    row,
    prisma: {
      account: {
        findUnique: ({ where }: { where: { email: string } }) =>
          Promise.resolve(users.find((u) => u.email === where.email) ?? null),
      },
      accountPin: {
        // The row always exists in practice; upsert's update branch is what runs.
        upsert: ({ update }: { update: Partial<Door> }) => {
          Object.assign(row, update);
          return Promise.resolve(withUser());
        },
        findUnique: () => Promise.resolve(withUser()),
      },
    },
  };
}

const ADMIN = { id: USER_ID, email: 'admin@example.com', accountType: 'staff' };
const CLIENT = { id: 'u9', email: 'owner@client.example', accountType: 'client' };

describe('setAccountPin', () => {
  it('stores an Argon2 hash, never the digits', async () => {
    const { prisma, row } = fakePrisma([ADMIN]);
    await setAccountPin(prisma as never, 'admin@example.com', KEY);

    expect(row.keyHash).not.toBe(KEY);
    expect(row.keyHash).toMatch(/^\$argon2/);
    await expect(verifyPassword(row.keyHash!, KEY)).resolves.toBe(true);
  });

  it('points the door at the named account', async () => {
    const { prisma, row } = fakePrisma([ADMIN]);
    await setAccountPin(prisma as never, 'admin@example.com', KEY);

    expect(row.accountId).toBe(USER_ID);
  });

  it('writes the key and the account together', async () => {
    // account_pin_pairing rejects one without the other, so a write that set
    // only the hash would fail at the database rather than here.
    const { prisma, row } = fakePrisma([ADMIN]);
    await setAccountPin(prisma as never, 'admin@example.com', KEY);

    expect(row.keyHash === null).toBe(row.accountId === null);
  });

  it('moves the door from one account to another', async () => {
    // With several accounts this is how the PIN is handed over.
    const { prisma, row } = fakePrisma(
      [ADMIN, { id: OTHER_ID, email: 'second@example.com', accountType: 'staff' }],
      { accountId: USER_ID, keyHash: 'old' },
    );
    await setAccountPin(prisma as never, 'second@example.com', '999888');

    expect(row.accountId).toBe(OTHER_ID);
    await expect(verifyPassword(row.keyHash!, '999888')).resolves.toBe(true);
  });

  it('clears the lockout, which is what makes this a recovery path', async () => {
    const { prisma, row } = fakePrisma([ADMIN], {
      failedAttempts: 5,
      lockoutCount: 9,
      lockedUntil: new Date(Date.now() + 3_600_000),
    });
    await setAccountPin(prisma as never, 'admin@example.com', KEY);

    expect(row.failedAttempts).toBe(0);
    expect(row.lockoutCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('refuses a key that is not exactly six digits', async () => {
    const { prisma, row } = fakePrisma([ADMIN]);

    for (const bad of ['12345', '1234567', 'abcdef', '', '04271a']) {
      await expect(setAccountPin(prisma as never, 'admin@example.com', bad)).rejects.toThrow(
        /six digits/,
      );
    }
    expect(row.keyHash).toBeNull();
  });

  it('refuses an email with no account rather than creating one', async () => {
    // Unlike seed:admin this must not upsert: a mistyped address would hand the
    // PIN to a login nobody meant to exist.
    const { prisma, row } = fakePrisma([ADMIN]);

    await expect(setAccountPin(prisma as never, 'ghost@example.com', KEY)).rejects.toThrow(
      /no account/i,
    );
    expect(row.accountId).toBeNull();
  });
});

describe('setAccountPin and account types', () => {
  it('refuses to give the PIN to a client account', async () => {
    // Whoever holds the PIN can open billing. A client never should.
    const { prisma, row } = fakePrisma([ADMIN, CLIENT]);
    await expect(setAccountPin(prisma as never, CLIENT.email, KEY)).rejects.toThrow(/only be held by staff/);
    expect(row.accountId).toBeNull();
    expect(row.keyHash).toBeNull();
  });
});

describe('clearAccountPin', () => {
  it('nulls the key and the account together, and drops the lockout', async () => {
    // accountId has to go too: the pairing CHECK requires it, and leaving the
    // account referenced would keep the database refusing to delete it.
    const { prisma, row } = fakePrisma([ADMIN], {
      accountId: USER_ID,
      keyHash: 'whatever',
      lockoutCount: 3,
      lockedUntil: new Date(),
    });
    await clearAccountPin(prisma as never);

    expect(row.keyHash).toBeNull();
    expect(row.accountId).toBeNull();
    expect(row.lockoutCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

describe('accountPinHolder', () => {
  it('names the account the PIN opens', async () => {
    const { prisma } = fakePrisma([ADMIN], { accountId: USER_ID, keyHash: 'set' });

    await expect(accountPinHolder(prisma as never)).resolves.toBe('admin@example.com');
  });

  it('is null when no key is configured', async () => {
    const { prisma } = fakePrisma([ADMIN]);

    await expect(accountPinHolder(prisma as never)).resolves.toBeNull();
  });
});
