import { burnVerifyTime, hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('produces an argon2id hash', async () => {
    const hashed = await hashPassword('correct horse battery staple');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('accepts the correct password', async () => {
    const hashed = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hashed, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hashed = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hashed, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A truncated or hand-edited column value must read as "wrong password",
    // never as a 500 that tells the caller the row exists.
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('burns verify time without throwing', async () => {
    await expect(burnVerifyTime('anything')).resolves.toBeUndefined();
  });
});
