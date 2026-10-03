import { JWK } from 'jose';
import { TokenKeys, generateSigningJwk, loadTokenKeys } from '../src/auth/token-keys';

export const TEST_ISSUER = 'https://auth.test.local';
export const BILLING_ORIGIN = 'https://billing.test.local';
export const STUDIO_ORIGIN = 'https://studio.test.local';
export const TEST_PORTAL_ORIGINS = `${BILLING_ORIGIN}=billing,${STUDIO_ORIGIN}=studio`;

export interface TestKeyMaterial {
  privateJwk: JWK;
  publicJwk: JWK;
  keys: TokenKeys;
}

const cache = new Map<string, Promise<TestKeyMaterial>>();

/**
 * One P-256 key pair per kid per test run. Generating is cheap but not free,
 * and a stable key per kid lets a suite sign with "the service's key" and with
 * "some other key" without either changing between cases.
 */
export function testKeyMaterial(kid = 'test-key'): Promise<TestKeyMaterial> {
  let entry = cache.get(kid);
  if (entry === undefined) {
    entry = (async () => {
      const { privateJwk, publicJwk } = await generateSigningJwk(kid);
      const keys = await loadTokenKeys({ issuer: TEST_ISSUER, signingJwk: JSON.stringify(privateJwk) });
      return { privateJwk, publicJwk, keys };
    })();
    cache.set(kid, entry);
  }
  return entry;
}

export async function testKeys(kid = 'test-key'): Promise<TokenKeys> {
  return (await testKeyMaterial(kid)).keys;
}

/** The environment the real AppModule needs to boot, with the test key. */
export async function testEnv(): Promise<Record<string, string>> {
  const { privateJwk } = await testKeyMaterial();
  return {
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_SIGNING_JWK: JSON.stringify(privateJwk),
    AUTH_PORTAL_ORIGINS: TEST_PORTAL_ORIGINS,
  };
}
