import { SignJWT, decodeProtectedHeader } from 'jose';
import { TEST_ISSUER, testKeys } from '../../test/test-keys';
import { TokenKeys } from './token-keys';
import { signAccessToken, signRefreshToken, verifyToken } from './session-token';

const CLAIMS = {
  id: 'a3f1c2d4-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  sid: '6b1f0a52-3c1e-4d8e-9a57-1f2e3d4c5b6a',
};

let KEYS: TokenKeys;
let OTHER_KEYS: TokenKeys;

beforeAll(async () => {
  KEYS = await testKeys();
  OTHER_KEYS = await testKeys('some-other-key');
});

/** Every existing guarantee, stated against a billing access token. */
const signSession = (keys = KEYS) => signAccessToken(CLAIMS, 'billing', keys);
const verifySession = (token: string) => verifyToken(token, KEYS, 'access', 'billing');

/** A hand-built token, so a case can vary exactly one thing. */
function craft(payload: Record<string, unknown>, keys = KEYS) {
  return new SignJWT({ email: CLAIMS.email, sid: CLAIMS.sid, typ: 'access', ...payload })
    .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
    .setSubject(CLAIMS.id)
    .setIssuer(TEST_ISSUER)
    .setAudience('billing')
    .setIssuedAt();
}

describe('access token', () => {
  it('round-trips the claims', async () => {
    expect(await verifySession(await signSession())).toEqual(CLAIMS);
  });

  it('names its signing key in the header, which is what makes rotation possible', async () => {
    expect(decodeProtectedHeader(await signSession())).toEqual({ alg: 'ES256', kid: KEYS.kid });
  });

  it('rejects a token signed with a different key', async () => {
    expect(await verifySession(await signSession(OTHER_KEYS))).toBeNull();
  });

  it('rejects a token signed with a different key that borrows our kid', async () => {
    // The header is attacker-controlled. Naming our kid must not make a foreign
    // signature acceptable.
    const forged = await craft({}, KEYS)
      .setExpirationTime('15m')
      .sign(OTHER_KEYS.privateKey);
    expect(await verifySession(forged)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession();
    const [header, payload, signature] = token.split('.');
    const middle = Math.floor(signature.length / 2);
    const flipped = signature[middle] === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${signature.slice(0, middle)}${flipped}${signature.slice(middle + 1)}`;

    expect(tampered).not.toBe(token);
    expect(await verifySession(tampered)).toBeNull();
  });

  it('rejects a token whose claims have been rewritten under the original signature', async () => {
    const token = await signSession();
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        email: 'attacker@example.com',
        sid: CLAIMS.sid,
        typ: 'access',
        iss: TEST_ISSUER,
        aud: 'billing',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    expect(await verifySession(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const expired = await craft({})
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(KEYS.privateKey);
    expect(await verifySession(expired)).toBeNull();
  });

  it('rejects an unsigned alg:none token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: CLAIMS.id, email: CLAIMS.email, sid: CLAIMS.sid, typ: 'access' }),
    ).toString('base64url');
    expect(await verifySession(`${header}.${body}.`)).toBeNull();
  });

  it('rejects an HS256 token, even one keyed with our public key', async () => {
    // Algorithm confusion: a verifier that let the header choose the algorithm
    // could be fed an HMAC keyed with the (public) EC key material.
    const hmacKey = new TextEncoder().encode(JSON.stringify(KEYS.jwks.keys[0]));
    const confused = await new SignJWT({ email: CLAIMS.email, sid: CLAIMS.sid, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', kid: KEYS.kid })
      .setSubject(CLAIMS.id)
      .setIssuer(TEST_ISSUER)
      .setAudience('billing')
      .setExpirationTime('15m')
      .sign(hmacKey);
    expect(await verifySession(confused)).toBeNull();
  });

  it('rejects a token minted for another issuer', async () => {
    const foreign = await craft({}).setIssuer('https://elsewhere.example').setExpirationTime('15m').sign(KEYS.privateKey);
    expect(await verifySession(foreign)).toBeNull();
  });

  it('rejects a token minted for another audience', async () => {
    const foreign = await craft({}).setAudience('some-other-app').setExpirationTime('15m').sign(KEYS.privateKey);
    expect(await verifySession(foreign)).toBeNull();
  });

  it('rejects a token carrying no subject', async () => {
    const subjectless = await new SignJWT({ email: CLAIMS.email, sid: CLAIMS.sid, typ: 'access' })
      .setProtectedHeader({ alg: 'ES256', kid: KEYS.kid })
      .setIssuer(TEST_ISSUER)
      .setAudience('billing')
      .setExpirationTime('15m')
      .sign(KEYS.privateKey);
    expect(await verifySession(subjectless)).toBeNull();
  });

  it('rejects a token carrying no session id', async () => {
    const sidless = await craft({ sid: undefined }).setExpirationTime('15m').sign(KEYS.privateKey);
    expect(await verifySession(sidless)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySession('not.a.token')).toBeNull();
  });
});

describe('audiences', () => {
  it('addresses an access token to the portal it was minted for', async () => {
    const studio = await signAccessToken(CLAIMS, 'studio', KEYS);

    expect(await verifyToken(studio, KEYS, 'access', 'studio')).toEqual(CLAIMS);
  });

  it('refuses a studio token where a billing token is expected, and the reverse', async () => {
    // The point of per-portal audiences: a token one portal received is not a
    // credential at the other.
    const studio = await signAccessToken(CLAIMS, 'studio', KEYS);
    const billing = await signAccessToken(CLAIMS, 'billing', KEYS);

    expect(await verifyToken(studio, KEYS, 'access', 'billing')).toBeNull();
    expect(await verifyToken(billing, KEYS, 'access', 'studio')).toBeNull();
  });

  it('addresses the refresh token to this service, so no portal can accept it', async () => {
    const refresh = await signRefreshToken(CLAIMS, KEYS);
    const payload = JSON.parse(Buffer.from(refresh.split('.')[1]!, 'base64url').toString());

    expect(payload.aud).toBe(TEST_ISSUER);
    expect(await verifyToken(refresh, KEYS, 'access', 'billing')).toBeNull();
    expect(await verifyToken(refresh, KEYS, 'access', 'studio')).toBeNull();
  });
});

describe('token types are not interchangeable', () => {
  it('refuses a refresh token where an access token is expected', async () => {
    const refresh = await signRefreshToken(CLAIMS, KEYS);

    expect(await verifyToken(refresh, KEYS, 'access', 'billing')).toBeNull();
    expect(await verifyToken(refresh, KEYS, 'refresh')).toEqual(CLAIMS);
  });

  it('refuses an access token where a refresh token is expected', async () => {
    const access = await signSession();

    expect(await verifyToken(access, KEYS, 'refresh')).toBeNull();
    expect(await verifyToken(access, KEYS, 'access', 'billing')).toEqual(CLAIMS);
  });

  it('refuses a refresh-typed token addressed to a portal', async () => {
    // typ and aud are checked independently; either alone must be enough.
    const odd = await craft({ typ: 'refresh' }).setExpirationTime('12h').sign(KEYS.privateKey);
    expect(await verifyToken(odd, KEYS, 'refresh')).toBeNull();
  });

  it('refuses a token carrying no type at all', async () => {
    const untyped = await craft({ typ: undefined }).setExpirationTime('15m').sign(KEYS.privateKey);
    expect(await verifyToken(untyped, KEYS, 'access', 'billing')).toBeNull();
  });
});

describe('token lifetimes', () => {
  const expOf = (token: string): number =>
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp;

  it('gives the access token fifteen minutes', async () => {
    const ttl = expOf(await signSession()) - Math.floor(Date.now() / 1000);

    expect(ttl).toBeGreaterThan(14 * 60);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('gives the refresh token twelve hours', async () => {
    const ttl = expOf(await signRefreshToken(CLAIMS, KEYS)) - Math.floor(Date.now() / 1000);

    expect(ttl).toBeGreaterThan(12 * 60 * 60 - 60);
    expect(ttl).toBeLessThanOrEqual(12 * 60 * 60);
  });

  it('carries exactly the agreed claims and nothing else', async () => {
    // A JWT is signed, not encrypted: anything here is readable by whoever
    // holds the token.
    const payload = JSON.parse(Buffer.from((await signSession()).split('.')[1]!, 'base64url').toString());

    expect(Object.keys(payload).sort()).toEqual(['aud', 'email', 'exp', 'iat', 'iss', 'sid', 'sub', 'typ']);
  });
});
