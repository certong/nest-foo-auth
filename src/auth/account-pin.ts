import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from './password';

/**
 * The PIN door is a singleton: one row, always present, id 1. See AccountPin in
 * schema.prisma for why it is a row rather than columns on account.
 */
export const ACCOUNT_PIN_ID = 1;

/** The same shape the DTO enforces, so the CLI cannot seed a key the endpoint would reject. */
const SIX_DIGITS = /^\d{6}$/;

/** Cleared together on every path: a stale lock outlives the key it belonged to. */
const NO_LOCKOUT = { failedAttempts: 0, lockoutCount: 0, lockedUntil: null } as const;

async function userByEmail(prisma: PrismaService, email: string) {
  const user = await prisma.account.findUnique({ where: { email } });
  if (user === null) {
    // Deliberately not an upsert, unlike seed:admin. Silently creating an
    // account from a mistyped address would hand the PIN to a login nobody
    // meant to exist.
    throw new Error(`no account with email ${email}`);
  }
  return user;
}

/**
 * Points the PIN door at an account, sets its six-digit key, and clears any
 * lockout in force.
 *
 * That reset is not a convenience: it is the recovery path. A forgotten key, or
 * a backoff that has doubled its way to an hour, is resolved by running this.
 * Rotation and recovery are deliberately the same operation — there is no
 * separate unlock that would leave an unknown key in place.
 */
export async function setAccountPin(
  prisma: PrismaService,
  email: string,
  key: string,
): Promise<{ email: string }> {
  if (!SIX_DIGITS.test(key)) {
    throw new Error('key must be exactly six digits');
  }
  const user = await userByEmail(prisma, email);
  // The PIN is a staff door: whoever holds it can open billing. A client
  // holding it would be refused there anyway, but should never be given it.
  if (user.accountType !== 'staff') {
    throw new Error(`${user.email} is a ${user.accountType} account; the PIN can only be held by staff`);
  }
  const keyHash = await hashPassword(key);

  // accountId and keyHash are written together because account_pin_pairing
  // requires it: a key may never outlive the account it opens.
  await prisma.accountPin.upsert({
    where: { id: ACCOUNT_PIN_ID },
    create: { id: ACCOUNT_PIN_ID, accountId: user.id, keyHash },
    update: { accountId: user.id, keyHash, ...NO_LOCKOUT },
  });
  return { email: user.email };
}

/**
 * Removes the key entirely, returning the deployment to password-only sign-in.
 *
 * Takes no email: the door is one thing, not a property of an account, and
 * there is only ever one to clear. Nulls accountId alongside keyHash, both
 * because the pairing CHECK requires it and because leaving the account
 * referenced would keep the database refusing to delete it.
 *
 * Not observable from outside — POST /auth/key still counts down and still
 * locks afterwards, exactly as it does for a wrong key.
 */
export async function clearAccountPin(prisma: PrismaService): Promise<void> {
  await prisma.accountPin.upsert({
    where: { id: ACCOUNT_PIN_ID },
    create: { id: ACCOUNT_PIN_ID },
    update: { accountId: null, keyHash: null, ...NO_LOCKOUT },
  });
}

/**
 * Which account the PIN currently opens, or null when none is configured.
 *
 * With more than one account there is otherwise no way to find this out, and
 * the endpoint itself will not say — every rejection is deliberately uniform.
 */
export async function accountPinHolder(prisma: PrismaService): Promise<string | null> {
  const door = await prisma.accountPin.findUnique({
    where: { id: ACCOUNT_PIN_ID },
    include: { account: true },
  });
  return door?.keyHash != null && door.account != null ? door.account.email : null;
}
