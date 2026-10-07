import { execFileSync } from 'node:child_process';
import { SignJWT, jwtVerify } from 'jose';
import { ALGORITHM, loadTokenKeys } from '../src/auth/token-keys';
import { TEST_ISSUER } from './test-keys';

/**
 * `npm run signing-key:generate` is how every environment's key is made, and the
 * two lines it prints are copied by hand into that environment's secrets. So the
 * thing worth testing is not generateSigningJwk — token-keys.spec.ts covers that
 * — but whether what the script actually prints can be pasted back in and used.
 *
 * It runs the real script, so the quoting of the printed lines is part of the
 * test. Spawned through node with ts-node's own entry point rather than npx, so
 * it depends on neither a shell nor PATH.
 */

const TS_NODE = require.resolve('ts-node/dist/bin.js');

// ts-node recompiles the script on every spawn, which costs a couple of seconds
// each time; one run per kid is enough, since the key itself is never asserted on.
const runs = new Map<string, string>();

function runGenerateScript(kid?: string): string {
  const cached = runs.get(kid ?? '');
  if (cached !== undefined) {
    return cached;
  }
  const output = execFileSync(
    process.execPath,
    [TS_NODE, '-P', 'tsconfig.json', 'scripts/generate-signing-key.ts'],
    {
      encoding: 'utf8',
      env: kid === undefined ? process.env : { ...process.env, SIGNING_KEY_ID: kid },
    },
  );
  runs.set(kid ?? '', output);
  return output;
}

/** The value as it is pasted into the environment, with the script's quotes off. */
function envValue(output: string, prefix: string): string {
  const line = output
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .find((l) => l.startsWith(prefix));

  expect(line, `no "${prefix}" line in:\n${output}`).toBeDefined();
  return line!.slice(prefix.length).replace(/^'|'$/g, '');
}

const TIMEOUT = 60_000;

describe('signing-key:generate', () => {
  it(
    'prints a private key loadTokenKeys accepts, and a token it signs verifies',
    async () => {
      const keys = await loadTokenKeys({
        issuer: TEST_ISSUER,
        signingJwk: envValue(runGenerateScript('2026-10-a'), 'AUTH_SIGNING_JWK='),
      });
      expect(keys.kid).toBe('2026-10-a');

      // Not just "it loaded": the key has to be able to sign, and the JWKS the
      // service would publish has to verify what it signed.
      const token = await new SignJWT({ sub: 'someone' })
        .setProtectedHeader({ alg: ALGORITHM, kid: keys.kid })
        .setIssuer(keys.issuer)
        .setExpirationTime('5m')
        .sign(keys.privateKey);

      await expect(jwtVerify(token, keys.keySet, { issuer: keys.issuer })).resolves.toBeDefined();
    },
    TIMEOUT,
  );

  it(
    'prints a public half AUTH_PUBLISHED_JWKS accepts, which is what a rotation pastes',
    async () => {
      // Step one of a rotation is putting the new public key into
      // AUTH_PUBLISHED_JWKS on the still-running service. If the printed public
      // line were not a valid entry there, the rotation would fail at boot —
      // after the old key had already been announced as going away.
      const incoming = runGenerateScript('2026-10-b');
      const current = runGenerateScript('2026-10-a');

      const keys = await loadTokenKeys({
        issuer: TEST_ISSUER,
        signingJwk: envValue(current, 'AUTH_SIGNING_JWK='),
        publishedJwks: `[${envValue(incoming, 'public JWK: ')}]`,
      });

      expect(keys.jwks.keys.map((k) => k.kid)).toEqual(['2026-10-a', '2026-10-b']);
      // The published half must not carry the private scalar, or reading the
      // JWKS would be enough to mint tokens.
      expect(keys.jwks.keys.some((k) => 'd' in k)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'defaults the kid to a date, so two keys made on different days cannot collide',
    async () => {
      // loadTokenKeys refuses two keys under one kid, so the default has to vary.
      const jwk: { kid?: string } = JSON.parse(
        envValue(runGenerateScript(), 'AUTH_SIGNING_JWK='),
      );

      expect(jwk.kid).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
    TIMEOUT,
  );
});
