import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_PIN_ID } from './account-pin';
import { AccountType, isAccountType } from './account-type';
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
 * A staff account may enter every portal and see everything in each. A client
 * account belongs to one billing client (clientId) and may enter studio only.
 * Whether that client id exists in billing is not checked — this service never
 * reads billing's schema — so the caller confirms it.
 */
export async function addUser(
  prisma: PrismaService,
  email: string,
  password: string,
  options: { accountType?: string; clientId?: number | null } = {},
): Promise<{ email: string; accountType: AccountType; clientId: number | null }> {
  // login lowercases and trims before its unique lookup, so an account stored
  // any other way could never be signed into.
  const normalised = email.trim().toLowerCase();

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const { accountType, clientId } = readAccountType(options.accountType, options.clientId);
  if ((await prisma.account.findUnique({ where: { email: normalised } })) !== null) {
    throw new Error(`an account for ${normalised} already exists`);
  }

  const user = await prisma.account.create({
    data: { email: normalised, passwordHash: await hashPassword(password), accountType, clientId },
  });
  return { email: user.email, accountType, clientId };
}

/**
 * The same pairing the account_client_pairing CHECK enforces, checked first so
 * the script fails with a sentence rather than a constraint name.
 */
function readAccountType(
  type: string | undefined,
  clientId: number | null | undefined,
): { accountType: AccountType; clientId: number | null } {
  const accountType = type === undefined || type === '' ? 'staff' : type;
  if (!isAccountType(accountType)) {
    throw new Error(`account type must be staff or client, got "${type}"`);
  }
  if (accountType === 'client') {
    if (clientId === undefined || clientId === null || !Number.isInteger(clientId) || clientId <= 0) {
      throw new Error('a client account needs the billing client id it belongs to (a positive whole number)');
    }
    return { accountType, clientId };
  }
  if (clientId !== undefined && clientId !== null) {
    throw new Error('a staff account belongs to no client; leave the client id unset');
  }
  return { accountType, clientId: null };
}

/**
 * Cuts a login off, or lets it back in. Both login and refresh refuse a
 * disabled account, so an open session ends at its next refresh — within
 * fifteen minutes, the life of the access token it already holds.
 *
 * Not a delete: the row, its auth_event history and any PIN pairing stay, and
 * enabling it again restores the same account.
 */
export async function setDisabled(
  prisma: PrismaService,
  email: string,
  disabled: boolean,
): Promise<{ email: string; disabled: boolean }> {
  const normalised = email.trim().toLowerCase();
  const user = await prisma.account.findUnique({ where: { email: normalised } });
  if (user === null) {
    throw new Error(`no account with email ${normalised}`);
  }
  await prisma.account.update({
    where: { id: user.id },
    data: { disabledAt: disabled ? new Date() : null },
  });
  return { email: user.email, disabled };
}

export interface UserSummary {
  email: string;
  createdAt: Date;
  accountType: string;
  clientId: number | null;
  disabled: boolean;
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
    accountType: user.accountType,
    clientId: user.clientId,
    disabled: user.disabledAt !== null,
    holdsKey: user.id === holder,
  }));
}
