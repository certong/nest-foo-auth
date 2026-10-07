import { addUser, listUsers, seedAdmin, setDisabled } from './user-admin';
import { verifyPassword } from './password';

const PASSWORD = 'correct-horse-battery';

interface Row {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  accountType?: string;
  clientId?: number | null;
  disabledAt?: Date | null;
}

function fakePrisma(rows: Row[], keyHolderId: string | null = null) {
  return {
    rows,
    prisma: {
      account: {
        findUnique: ({ where }: { where: { email: string } }) =>
          Promise.resolve(rows.find((r) => r.email === where.email) ?? null),
        create: ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
          const row = { id: `u${rows.length + 1}`, createdAt: new Date(), ...data };
          rows.push(row);
          return Promise.resolve(row);
        },
        findMany: () =>
          Promise.resolve(rows.map((r) => ({ accountType: 'staff', clientId: null, disabledAt: null, ...r }))),
        update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
        upsert: ({
          where,
          create,
          update,
        }: {
          where: { email: string };
          create: Omit<Row, 'id' | 'createdAt'>;
          update: Partial<Row>;
        }) => {
          const existing = rows.find((r) => r.email === where.email);
          if (existing !== undefined) {
            Object.assign(existing, update);
            return Promise.resolve(existing);
          }
          const row = { id: `u${rows.length + 1}`, createdAt: new Date(), ...create };
          rows.push(row);
          return Promise.resolve(row);
        },
      },
      accountPin: {
        findUnique: () =>
          Promise.resolve({
            keyHash: keyHolderId === null ? null : 'set',
            account: rows.find((r) => r.id === keyHolderId) ?? null,
          }),
      },
    },
  };
}

describe('addUser', () => {
  it('creates an account with an Argon2 password hash', async () => {
    const { prisma, rows } = fakePrisma([]);
    await addUser(prisma as never, 'new@example.com', PASSWORD);

    expect(rows).toHaveLength(1);
    expect(rows[0].passwordHash).toMatch(/^\$argon2/);
    await expect(verifyPassword(rows[0].passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('refuses an email that already has an account', async () => {
    // The difference from seed:admin, which upserts. Once more than one account
    // exists, silently overwriting somebody's password on a typo is a real way
    // to lock a person out.
    const { prisma, rows } = fakePrisma([
      { id: 'u1', email: 'taken@example.com', passwordHash: 'existing', createdAt: new Date() },
    ]);

    await expect(addUser(prisma as never, 'taken@example.com', PASSWORD)).rejects.toThrow(
      /already exists/i,
    );
    expect(rows[0].passwordHash).toBe('existing');
  });

  it('normalises the email the way login does', async () => {
    // login lowercases and trims before its unique lookup, so an account stored
    // any other way could never be signed into.
    const { prisma, rows } = fakePrisma([]);
    await addUser(prisma as never, '  Mixed@Example.COM  ', PASSWORD);

    expect(rows[0].email).toBe('mixed@example.com');
  });

  it('refuses a short password', async () => {
    const { prisma, rows } = fakePrisma([]);

    await expect(addUser(prisma as never, 'new@example.com', 'short')).rejects.toThrow(
      /at least 12/,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('seedAdmin', () => {
  it('creates a staff account when the address is new', async () => {
    const { prisma, rows } = fakePrisma([]);

    await expect(seedAdmin(prisma as never, 'you@example.com', PASSWORD)).resolves.toEqual({
      email: 'you@example.com',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'you@example.com', accountType: 'staff' });
    await expect(verifyPassword(rows[0].passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('changes an existing staff password, because this is the reset path', async () => {
    // There is no password reset flow. A second run has to update rather than
    // refuse, or a lost password could not be recovered at all.
    const rows: Row[] = [
      { id: 'u1', email: 'you@example.com', passwordHash: 'old', createdAt: new Date(), accountType: 'staff' },
    ];
    const { prisma } = fakePrisma(rows);

    await seedAdmin(prisma as never, 'you@example.com', 'a-brand-new-password');

    expect(rows).toHaveLength(1);
    await expect(verifyPassword(rows[0].passwordHash, 'a-brand-new-password')).resolves.toBe(true);
  });

  it('refuses a client account and leaves its password alone', async () => {
    // Otherwise this script is the way to take over a client login: reset its
    // password, sign in as it. It would not even be the admin account it
    // handed over, since a client may enter studio only.
    const rows: Row[] = [
      { id: 'u1', email: 'owner@client.example', passwordHash: 'untouched', createdAt: new Date(), accountType: 'client', clientId: 42 },
    ];
    const { prisma } = fakePrisma(rows);

    await expect(seedAdmin(prisma as never, 'owner@client.example', PASSWORD)).rejects.toThrow(
      /owner@client.example is a client account; seed:admin only manages staff/,
    );
    expect(rows[0].passwordHash).toBe('untouched');
    expect(rows[0].accountType).toBe('client');
  });

  it('refuses a client account however the address is typed', async () => {
    // The refusal has to survive normalisation, or the same login is reachable
    // again by changing the case of its address.
    const rows: Row[] = [
      { id: 'u1', email: 'owner@client.example', passwordHash: 'untouched', createdAt: new Date(), accountType: 'client', clientId: 42 },
    ];
    const { prisma } = fakePrisma(rows);

    await expect(seedAdmin(prisma as never, '  Owner@Client.Example  ', PASSWORD)).rejects.toThrow(
      /only manages staff/,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].passwordHash).toBe('untouched');
  });

  it('normalises the email the way login does', async () => {
    const { prisma, rows } = fakePrisma([]);
    await seedAdmin(prisma as never, '  You@Example.COM  ', PASSWORD);

    expect(rows[0].email).toBe('you@example.com');
  });

  it('refuses a short password, before writing anything', async () => {
    const { prisma, rows } = fakePrisma([]);

    await expect(seedAdmin(prisma as never, 'you@example.com', 'short')).rejects.toThrow(
      /ADMIN_PASSWORD must be at least 12 characters/,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('listUsers', () => {
  it('marks which account holds the PIN', async () => {
    // With several accounts there is no other way to find out — the endpoint
    // itself will not say, because every rejection is deliberately uniform.
    const rows = [
      { id: 'u1', email: 'a@example.com', passwordHash: 'x', createdAt: new Date() },
      { id: 'u2', email: 'b@example.com', passwordHash: 'x', createdAt: new Date() },
    ];
    const { prisma } = fakePrisma(rows, 'u2');

    await expect(listUsers(prisma as never)).resolves.toEqual([
      { email: 'a@example.com', createdAt: rows[0].createdAt, accountType: 'staff', clientId: null, disabled: false, holdsKey: false },
      { email: 'b@example.com', createdAt: rows[1].createdAt, accountType: 'staff', clientId: null, disabled: false, holdsKey: true },
    ]);
  });

  it('reports no holder when no PIN is configured', async () => {
    const rows = [{ id: 'u1', email: 'a@example.com', passwordHash: 'x', createdAt: new Date() }];
    const { prisma } = fakePrisma(rows, null);

    await expect(listUsers(prisma as never)).resolves.toEqual([
      { email: 'a@example.com', createdAt: rows[0].createdAt, accountType: 'staff', clientId: null, disabled: false, holdsKey: false },
    ]);
  });
});

describe('addUser account types', () => {
  it('creates staff by default, with no client', async () => {
    const { prisma, rows } = fakePrisma([]);
    await expect(addUser(prisma as never, 'staff@example.com', PASSWORD)).resolves.toEqual({
      email: 'staff@example.com',
      accountType: 'staff',
      clientId: null,
    });
    expect(rows[0]).toMatchObject({ accountType: 'staff', clientId: null });
  });

  it('creates a client tied to its billing client', async () => {
    const { prisma, rows } = fakePrisma([]);
    await addUser(prisma as never, 'owner@client.example', PASSWORD, { accountType: 'client', clientId: 42 });
    expect(rows[0]).toMatchObject({ accountType: 'client', clientId: 42 });
  });

  it.each([
    ['an unknown type', { accountType: 'admin' }, /staff or client/],
    ['a client with no client id', { accountType: 'client' }, /needs the billing client id/],
    ['a client with client id 0', { accountType: 'client', clientId: 0 }, /needs the billing client id/],
    ['a client with a non-number client id', { accountType: 'client', clientId: Number('abc') }, /needs the billing client id/],
    ['staff with a client id', { accountType: 'staff', clientId: 42 }, /belongs to no client/],
  ])('refuses %s, before writing anything', async (_label, options, message) => {
    const { prisma, rows } = fakePrisma([]);
    await expect(addUser(prisma as never, 'x@example.com', PASSWORD, options)).rejects.toThrow(message);
    expect(rows).toHaveLength(0);
  });
});

describe('setDisabled', () => {
  it('disables and re-enables by email, keeping the row', async () => {
    const rows: Row[] = [{ id: 'u1', email: 'owner@client.example', passwordHash: 'x', createdAt: new Date(), disabledAt: null }];
    const { prisma } = fakePrisma(rows);

    await setDisabled(prisma as never, ' Owner@Client.example ', true);
    expect(rows[0].disabledAt).toBeInstanceOf(Date);

    await setDisabled(prisma as never, 'owner@client.example', false);
    expect(rows[0].disabledAt).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it('refuses an email with no account', async () => {
    const { prisma } = fakePrisma([]);
    await expect(setDisabled(prisma as never, 'nobody@example.com', true)).rejects.toThrow(/no account/);
  });
});
