import { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JWK,
  JWTVerifyGetKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';

/**
 * ES256 only. Pinned when signing and when verifying; accepting whatever a
 * token's header claims is the alg:none / algorithm-confusion forgery.
 */
export const ALGORITHM = 'ES256';

/**
 * Everything token signing and verification needs, built once at boot.
 *
 * Asymmetric now, where billing used an HS256 shared secret: two other services
 * verify these tokens, and with a shared secret every verifier could also mint.
 * The private key exists only in this service's environment; the public half is
 * what /.well-known/jwks.json serves.
 */
export interface TokenKeys {
  /** `iss` on every token, and `aud` on refresh tokens. AUTH_ISSUER. */
  issuer: string;
  /** Carried in every token header so verifiers pick the right key. */
  kid: string;
  privateKey: CryptoKey;
  /** The public signing key plus any rotation keys, exactly as served. */
  jwks: { keys: JWK[] };
  /**
   * This service verifies its own tokens (refresh cookie, /me) against the same
   * set it publishes, locally — never by fetching its own JWKS over HTTP.
   */
  keySet: JWTVerifyGetKey;
}

export interface TokenKeysEnv {
  issuer?: string;
  signingJwk?: string;
  publishedJwks?: string;
}

/**
 * Throws on anything unusable, so a bad key configuration stops the process at
 * boot rather than at the first sign-in.
 */
export async function loadTokenKeys(env: TokenKeysEnv): Promise<TokenKeys> {
  const issuer = readIssuer(env.issuer);
  const signing = readSigningJwk(env.signingJwk);
  const published = readPublishedJwks(env.publishedJwks);

  const privateKey = (await importJWK(signing, ALGORITHM)) as CryptoKey;

  const jwks = { keys: [publicHalf(signing), ...published.map(publicHalf)] };
  const seen = new Set<string>();
  for (const { kid } of jwks.keys) {
    // Two keys under one kid make "which key verifies this token" ambiguous,
    // and verifiers cache by kid, so a collision can pin them to the wrong one.
    if (seen.has(kid!)) {
      throw new Error(`AUTH_PUBLISHED_JWKS: duplicate kid "${kid}"`);
    }
    seen.add(kid!);
  }

  return { issuer, kid: signing.kid!, privateKey, jwks, keySet: createLocalJWKSet(jwks) };
}

/**
 * A fresh P-256 key pair as JWKs, for `npm run signing-key:generate` and tests.
 */
export async function generateSigningJwk(kid: string): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  const privateJwk: JWK = { ...(await exportJWK(privateKey)), kid, alg: ALGORITHM };
  return { privateJwk, publicJwk: publicHalf(privateJwk) };
}

function readIssuer(value: string | undefined): string {
  if (!value) {
    throw new Error('AUTH_ISSUER must be set to this service’s URL, e.g. https://auth.example.com');
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`AUTH_ISSUER must be a URL, got "${value}"`);
  }
  return value;
}

function readSigningJwk(value: string | undefined): JWK {
  if (!value) {
    throw new Error('AUTH_SIGNING_JWK must be set (npm run signing-key:generate makes one)');
  }
  const jwk = parseJson(value, 'AUTH_SIGNING_JWK');
  assertP256(jwk, 'AUTH_SIGNING_JWK');
  if (typeof jwk.d !== 'string' || jwk.d.length === 0) {
    throw new Error('AUTH_SIGNING_JWK must be a private key (it has no "d")');
  }
  return jwk;
}

function readPublishedJwks(value: string | undefined): JWK[] {
  if (!value || value.trim() === '') {
    return [];
  }
  const parsed: unknown = parseJson(value, 'AUTH_PUBLISHED_JWKS');
  if (!Array.isArray(parsed)) {
    throw new Error('AUTH_PUBLISHED_JWKS must be a JSON array of public JWKs');
  }
  return parsed.map((jwk: JWK) => {
    assertP256(jwk, 'AUTH_PUBLISHED_JWKS');
    // Publishing a private key would let anyone who reads the JWKS mint tokens.
    if ('d' in jwk) {
      throw new Error(`AUTH_PUBLISHED_JWKS: key "${jwk.kid}" is a private key; publish public keys only`);
    }
    return jwk;
  });
}

function assertP256(jwk: JWK, source: string): void {
  if (jwk === null || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new Error(`${source}: expected an EC P-256 key`);
  }
  if (typeof jwk.kid !== 'string' || jwk.kid.trim() === '') {
    throw new Error(`${source}: every key needs a non-empty "kid"`);
  }
  if (jwk.alg !== undefined && jwk.alg !== ALGORITHM) {
    throw new Error(`${source}: key "${jwk.kid}" is labelled ${jwk.alg}; only ${ALGORITHM} is accepted`);
  }
}

function parseJson(value: string, source: string): JWK {
  try {
    return JSON.parse(value) as JWK;
  } catch {
    throw new Error(`${source} must be JSON (a JWK on one line)`);
  }
}

/** Only the public members, re-labelled; never copies `d` across. */
function publicHalf(jwk: JWK): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, alg: ALGORITHM, use: 'sig' };
}

/** DI token for the loaded keys. */
export const TOKEN_KEYS = Symbol('TOKEN_KEYS');

export const tokenKeysProvider: FactoryProvider<Promise<TokenKeys>> = {
  provide: TOKEN_KEYS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    loadTokenKeys({
      issuer: config.get<string>('AUTH_ISSUER'),
      signingJwk: config.get<string>('AUTH_SIGNING_JWK'),
      publishedJwks: config.get<string>('AUTH_PUBLISHED_JWKS'),
    }),
};
