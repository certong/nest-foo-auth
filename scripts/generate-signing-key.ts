/**
 * Prints a new ES256 signing key.
 *
 *   npm run signing-key:generate                 # kid defaults to today, e.g. 2026-10-03
 *   SIGNING_KEY_ID=2026-10-b npm run signing-key:generate
 *
 * Output, two lines you copy into the environment:
 *
 *   AUTH_SIGNING_JWK=...      the private key. Secret. This service only.
 *   public JWK: ...           the public half. Goes in AUTH_PUBLISHED_JWKS during
 *                             rotation (see README, "Rotating the signing key").
 *
 * Nothing is written to disk.
 */
import { generateSigningJwk } from '../src/auth/token-keys';

async function main(): Promise<void> {
  const kid = process.env.SIGNING_KEY_ID?.trim() || new Date().toISOString().slice(0, 10);
  const { privateJwk, publicJwk } = await generateSigningJwk(kid);

  console.log(`AUTH_SIGNING_JWK='${JSON.stringify(privateJwk)}'`);
  console.log(`public JWK: ${JSON.stringify(publicJwk)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
