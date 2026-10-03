import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** Argon2id at the library defaults, which track the OWASP recommendation. */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/**
 * False, never an exception, when the stored hash is unreadable. A malformed
 * column value is a wrong password as far as the caller is concerned; letting it
 * throw would turn it into a 500 that confirms the row exists.
 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/**
 * One throwaway hash, computed once per process, that an unknown-email login is
 * verified against. Without it, a missing row returns in microseconds while a
 * wrong password takes the full Argon2 cost, and the difference tells an
 * attacker which address is the administrator's.
 */
let dummyHash: Promise<string> | null = null;

export async function burnVerifyTime(plain: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(await dummyHash, plain);
}
