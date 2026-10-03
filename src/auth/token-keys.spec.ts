import { SignJWT, generateKeyPair, exportJWK, jwtVerify } from 'jose';
import { generateSigningJwk, loadTokenKeys } from './token-keys';

const ISSUER = 'https://auth.example.com';

async function env(overrides: Partial<Record<'issuer' | 'signingJwk' | 'publishedJwks', string>> = {}) {
  const { privateJwk } = await generateSigningJwk('2026-10-a');
  return { issuer: ISSUER, signingJwk: JSON.stringify(privateJwk), ...overrides };
}

describe('loadTokenKeys', () => {
  it('loads a P-256 private JWK and exposes its kid and issuer', async () => {
    const keys = await loadTokenKeys(await env());
    expect(keys.kid).toBe('2026-10-a');
    expect(keys.issuer).toBe(ISSUER);
  });

  it('publishes the public half only, labelled for ES256 signatures', async () => {
    const keys = await loadTokenKeys(await env());
    const [published] = keys.jwks.keys;

    expect(keys.jwks.keys).toHaveLength(1);
    expect(published).toMatchObject({ kid: '2026-10-a', alg: 'ES256', use: 'sig', kty: 'EC', crv: 'P-256' });
    expect(typeof published.x).toBe('string');
    expect(typeof published.y).toBe('string');
    // The private scalar. If this ever leaks into the JWKS, anyone can mint.
    expect(published).not.toHaveProperty('d');
  });

  it('signs with a key the published set verifies', async () => {
    const keys = await loadTokenKeys(await env());
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
      .setIssuer(ISSUER)
      .sign(keys.privateKey);

    await expect(jwtVerify(token, keys.keySet, { algorithms: ['ES256'] })).resolves.toBeDefined();
  });

  it('appends the rotation keys after the signing key', async () => {
    const { publicJwk } = await generateSigningJwk('2026-09-old');
    const keys = await loadTokenKeys(await env({ publishedJwks: JSON.stringify([publicJwk]) }));

    expect(keys.jwks.keys.map((k) => k.kid)).toEqual(['2026-10-a', '2026-09-old']);
  });

  it('verifies a token signed by a published rotation key, so the old key keeps working', async () => {
    // Rotation step 2: the new key signs, the old public key stays published so
    // refresh tokens it signed up to twelve hours ago still verify here.
    const old = await generateSigningJwk('2026-09-old');
    const keys = await loadTokenKeys(await env({ publishedJwks: JSON.stringify([old.publicJwk]) }));
    const { importJWK } = await import('jose');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: '2026-09-old' })
      .sign(await importJWK(old.privateJwk, 'ES256'));

    await expect(jwtVerify(token, keys.keySet, { algorithms: ['ES256'] })).resolves.toBeDefined();
  });

  it('treats an empty published list as no extra keys', async () => {
    const keys = await loadTokenKeys(await env({ publishedJwks: '' }));
    expect(keys.jwks.keys).toHaveLength(1);
  });
});

describe('loadTokenKeys refuses to boot on bad configuration', () => {
  it.each([
    ['no issuer', { issuer: '' }, /AUTH_ISSUER/],
    ['an issuer that is not a URL', { issuer: 'auth-service' }, /AUTH_ISSUER/],
    ['no signing key', { signingJwk: '' }, /AUTH_SIGNING_JWK/],
    ['a signing key that is not JSON', { signingJwk: '-----BEGIN PRIVATE KEY-----' }, /AUTH_SIGNING_JWK/],
    ['published keys that are not a JSON array', { publishedJwks: '{"keys":[]}' }, /AUTH_PUBLISHED_JWKS/],
  ])('%s', async (_label, overrides, message) => {
    await expect(loadTokenKeys(await env(overrides))).rejects.toThrow(message);
  });

  it('a public key where the private key belongs', async () => {
    const { publicJwk } = await generateSigningJwk('k');
    await expect(loadTokenKeys(await env({ signingJwk: JSON.stringify(publicJwk) }))).rejects.toThrow(
      /private/,
    );
  });

  it('a key with no kid, since rotation depends on it', async () => {
    const { privateJwk } = await generateSigningJwk('k');
    const { kid: _dropped, ...unlabelled } = privateJwk;
    await expect(loadTokenKeys(await env({ signingJwk: JSON.stringify(unlabelled) }))).rejects.toThrow(
      /kid/,
    );
  });

  it('a curve other than P-256', async () => {
    const { privateKey } = await generateKeyPair('ES384', { extractable: true });
    const jwk = { ...(await exportJWK(privateKey)), kid: 'k' };
    await expect(loadTokenKeys(await env({ signingJwk: JSON.stringify(jwk) }))).rejects.toThrow(
      /P-256/,
    );
  });

  it('an RSA key', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(privateKey)), kid: 'k' };
    await expect(loadTokenKeys(await env({ signingJwk: JSON.stringify(jwk) }))).rejects.toThrow(
      /P-256/,
    );
  });

  it('a key labelled for another algorithm', async () => {
    const { privateJwk } = await generateSigningJwk('k');
    await expect(
      loadTokenKeys(await env({ signingJwk: JSON.stringify({ ...privateJwk, alg: 'HS256' }) })),
    ).rejects.toThrow(/ES256/);
  });

  it('a private key in the published list', async () => {
    const { privateJwk } = await generateSigningJwk('old');
    await expect(
      loadTokenKeys(await env({ publishedJwks: JSON.stringify([privateJwk]) })),
    ).rejects.toThrow(/AUTH_PUBLISHED_JWKS.*private/);
  });

  it('two keys with the same kid', async () => {
    const { publicJwk } = await generateSigningJwk('2026-10-a');
    await expect(
      loadTokenKeys(await env({ publishedJwks: JSON.stringify([publicJwk]) })),
    ).rejects.toThrow(/duplicate kid/);
  });
});
