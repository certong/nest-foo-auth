import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from './password';

/** The same shape the DTO enforces, so the CLI cannot set a PIN the endpoint would reject. */
const SIX_DIGITS = /^\d{6}$/;

async function userByEmail(prisma: PrismaService, email: string) {
  const normalised = email.trim().toLowerCase();
  const user = await prisma.account.findUnique({ where: { email: normalised } });
  if (user === null) {
    // Deliberately not an upsert. Silently creating an account from a mistyped
    // address would hand a PIN to a login nobody meant to exist.
    throw new Error(`no account with email ${normalised}`);
  }
  return user;
}

/**
 * Sets or replaces one account's six-digit PIN (POST /auth/pin, FA-24).
 *
 * Staff and client accounts alike: studio is PIN-only, and clients sign in to
 * studio. Which portals the PIN then opens is the account type's business
 * (account-type.ts), checked at sign-in like the password.
 *
 * Does not clear a lockout. The lockout is per typed email and lives in the
 * running service's memory, out of a script's reach: it ends by itself after
 * fifteen minutes, on a restart, or when a staff account signs in to billing
 * with its password.
 */
export async function setAccountPin(
  prisma: PrismaService,
  email: string,
  pin: string,
): Promise<{ email: string }> {
  if (!SIX_DIGITS.test(pin)) {
    throw new Error('PIN must be exactly six digits');
  }
  const user = await userByEmail(prisma, email);
  const pinHash = await hashPassword(pin);

  await prisma.accountPin.upsert({
    where: { accountId: user.id },
    create: { accountId: user.id, pinHash },
    update: { pinHash },
  });
  return { email: user.email };
}

/**
 * Removes one account's PIN, so it can no longer use PIN sign-in. Its password,
 * if any portal still takes one, is untouched.
 *
 * Says whether there was a PIN to remove, so the script can tell "done" from
 * "nothing to do" — a mistyped address fails outright instead.
 */
export async function clearAccountPin(
  prisma: PrismaService,
  email: string,
): Promise<{ email: string; removed: boolean }> {
  const user = await userByEmail(prisma, email);
  const { count } = await prisma.accountPin.deleteMany({ where: { accountId: user.id } });
  return { email: user.email, removed: count > 0 };
}
