import { Prisma } from '@prisma/client';
import { clearAccountPin, setAccountPin } from '../../src/auth/account-pin';
import { hashPassword, verifyPassword } from '../../src/auth/password';
import { listUsers } from '../../src/auth/user-admin';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ThrowawayDatabase, createThrowawayDatabase, HAS_DATABASE } from './throwaway-database';

/** The migration before FA-24's, i.e. the singleton door. */
const BEFORE = '20261003140000_account_types';

describe.skipIf(!HAS_DATABASE)('20261015120000_per_account_pin', () => {
  let db: ThrowawayDatabase;
  const holder = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    db = await createThrowawayDatabase({ upTo: BEFORE });

    // The old shape, as a deployment that ran `key:set` has it: two accounts,
    // and the seeded door pointing at the first one.
    await db.prisma.$executeRaw(Prisma.sql`
      INSERT INTO auth.account (id, email, password_hash, updated_at) VALUES
        (${holder}::uuid, 'holder@example.com', 'x', now()),
        (${other}::uuid, 'other@example.com', 'x', now())`);
    await db.prisma.$executeRaw(Prisma.sql`
      UPDATE auth.account_pin
         SET account_id = ${holder}::uuid, key_hash = ${await hashPassword('042719')},
             failed_attempts = 3, lockout_count = 2
       WHERE id = 1`);

    db.migrate();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps the door PIN working, for the account that held it and no other', async () => {
    const rows = await db.prisma.accountPin.findMany();
    expect(rows).toEqual([
      { accountId: holder, pinHash: expect.stringMatching(/^\$argon2/), createdAt: expect.any(Date), updatedAt: expect.any(Date) },
    ]);
    await expect(verifyPassword(rows[0]!.pinHash, '042719')).resolves.toBe(true);
  });

  it('leaves exactly the new columns', async () => {
    const columns = await db.prisma.$queryRaw<{ column_name: string }[]>(Prisma.sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'account_pin' ORDER BY column_name`);
    expect(columns.map((c) => c.column_name)).toEqual(['account_id', 'created_at', 'pin_hash', 'updated_at']);
  });
});

describe.skipIf(!HAS_DATABASE)('a migration with no PIN set', () => {
  let db: ThrowawayDatabase;

  beforeAll(async () => {
    db = await createThrowawayDatabase({ upTo: BEFORE });
    db.migrate();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('drops the seed row rather than keeping an empty PIN', async () => {
    expect(await db.prisma.accountPin.count()).toBe(0);
  });
});

describe.skipIf(!HAS_DATABASE)('account_pin against Postgres', () => {
  let db: ThrowawayDatabase;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await createThrowawayDatabase();
    prisma = db.prisma as unknown as PrismaService;
  });

  afterAll(async () => {
    await db?.drop();
  });

  afterEach(async () => {
    await db.prisma.account.deleteMany();
  });

  const account = (email: string, accountType = 'staff', clientId: number | null = null) =>
    db.prisma.account.create({ data: { email, passwordHash: 'x', accountType, clientId } });

  it('holds one PIN per account, for staff and clients alike', async () => {
    await account('a@example.com');
    await account('c@client.example', 'client', 42);

    await setAccountPin(prisma, 'a@example.com', '111111');
    await setAccountPin(prisma, 'c@client.example', '222222');
    await setAccountPin(prisma, 'a@example.com', '333333');

    expect(await db.prisma.accountPin.count()).toBe(2);
    const users = await listUsers(prisma);
    expect(users.map((u) => [u.email, u.hasPin])).toEqual([
      ['a@example.com', true],
      ['c@client.example', true],
    ]);
  });

  it('deletes an account’s PIN with the account', async () => {
    const row = await account('gone@example.com');
    await setAccountPin(prisma, 'gone@example.com', '111111');

    await db.prisma.account.delete({ where: { id: row.id } });

    expect(await db.prisma.accountPin.count()).toBe(0);
  });

  it('removes a PIN with key:clear, and says when there was none', async () => {
    await account('a@example.com');
    await setAccountPin(prisma, 'a@example.com', '111111');

    await expect(clearAccountPin(prisma, 'a@example.com')).resolves.toEqual({ email: 'a@example.com', removed: true });
    await expect(clearAccountPin(prisma, 'a@example.com')).resolves.toEqual({ email: 'a@example.com', removed: false });
    expect((await listUsers(prisma))[0]!.hasPin).toBe(false);
  });

  it('refuses a PIN for an account that does not exist', async () => {
    await expect(
      db.prisma.accountPin.create({ data: { accountId: '00000000-0000-4000-8000-0000000000ff', pinHash: 'x' } }),
    ).rejects.toThrow();
  });
});
