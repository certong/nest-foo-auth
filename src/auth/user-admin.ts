import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_PIN_ID } from './account-pin';
import { hashPassword } from './password';

/**
 * Matches seed-admin.ts. This account is reachable from a public login route
 * and nothing limits what it can do once inside, so a short password here is
 * the whole attack surface.
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Creates a login account.
 *
 * Creates rather than upserts, which is the one real difference from
 * `seed:admin`. Upserting was safe while there was only ever one account; with
 * several, a mistyped address silently overwrites somebody else's password
 * instead of failing, and the person it belonged to is locked out with no
 * indication why.
 *
 * Every account is equal: there are no roles, and nothing records which account
 * wrote a row, so this grants full and untraceable access to all data.
 */
export async function addUser(
  prisma: PrismaService,
  email: string,
  password: string,
): Promise<{ email: string }> {
  // login lowercases and trims before its unique lookup, so an account stored
  // any other way could never be signed into.
  const normalised = email.trim().toLowerCase();

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if ((await prisma.account.findUnique({ where: { email: normalised } })) !== null) {
    throw new Error(`an account for ${normalised} already exists`);
  }

  const user = await prisma.account.create({
    data: { email: normalised, passwordHash: await hashPassword(password) },
  });
  return { email: user.email };
}

export interface UserSummary {
  email: string;
  createdAt: Date;
  /** True for the one account POST /auth/key signs in as. */
  holdsKey: boolean;
}

/**
 * Every account, and which one the PIN opens.
 *
 * The endpoint will not tell you which that is — every rejection is uniform on
 * purpose — so with more than one account this is the only way to find out.
 */
export async function listUsers(prisma: PrismaService): Promise<UserSummary[]> {
  const [users, door] = await Promise.all([
    prisma.account.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.accountPin.findUnique({
      where: { id: ACCOUNT_PIN_ID },
      include: { account: true },
    }),
  ]);

  const holder = door?.keyHash != null ? (door.account?.id ?? null) : null;
  return users.map((user) => ({
    email: user.email,
    createdAt: user.createdAt,
    holdsKey: user.id === holder,
  }));
}
