/**
 * Smoke-tests a running nest-foo-auth from the outside, the way a portal and a
 * product backend see it (docs/runbooks/deploy.md, step 5).
 *
 *   npm run smoke -- https://api-auth-development.foocertong.com https://billing-development.foocertong.com
 *   npm run smoke -- http://localhost:3001 http://localhost:5173
 *
 * First argument: this service's public URL, which must be its AUTH_ISSUER.
 * Second: one origin listed in its AUTH_PORTAL_ORIGINS.
 *
 * Two tiers. The first needs no account and no database, so it passes on a
 * service deployed ahead of the table handover (spec 11.4 step 1): health, the
 * JWKS, CORS and the origin rule. The second runs only when SMOKE_EMAIL and
 * SMOKE_PASSWORD are set: sign in, /me, refresh, sign out. It is a real sign-in
 * and leaves real rows in auth.auth_event (login_success, portal_entry, logout).
 *
 * Node rather than curl and jq: fetch is built in, so this needs nothing
 * installed and runs the same on Windows. Every POST sends Content-Type:
 * application/json, body or not, because the service answers 415 without it.
 */

const REFRESH_COOKIE_NAME = 'cp_refresh';
// Reserved by RFC 2606, so it can never be in anyone's AUTH_PORTAL_ORIGINS.
const FOREIGN_ORIGIN = 'https://smoke.invalid';

const [urlArg, originArg] = process.argv.slice(2);
if (!urlArg || !originArg) {
  console.error('usage: npm run smoke -- <auth url> <portal origin>');
  process.exit(2);
}

// Both must be bare origins. A trailing slash or a path on either is the same
// mistake the service refuses in AUTH_PORTAL_ORIGINS, and on the URL it would
// make the `iss` comparison below fail for the wrong reason.
for (const [name, value] of [['auth url', urlArg], ['portal origin', originArg]]) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`${name} is not a URL: ${value}`);
    process.exit(2);
  }
  if (parsed.origin !== value) {
    console.error(`${name} must be scheme, host and port only (got ${value}, expected ${parsed.origin})`);
    process.exit(2);
  }
}

const base = urlArg;
const origin = originArg;
const deployed = base.startsWith('https://');

let failed = 0;

async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  ok    ${name}`);
    if (note) console.log(`        ${note}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function post(path, { from, cookie, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (from) headers.Origin = from;
  if (cookie) headers.Cookie = cookie;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function preflight(from) {
  return fetch(`${base}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: from,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
}

// The cookie as the service set it: its value for sending back, its attributes
// (lower-cased names) for checking.
function refreshCookie(response) {
  const line = response.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!line) return null;
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  return {
    pair,
    value: pair.slice(REFRESH_COOKIE_NAME.length + 1),
    attributes: attributes.map((a) => a.toLowerCase()),
  };
}

function claimsOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

console.log(`== ${base}, as ${origin}`);
console.log('== 1. without an account');

await check('GET /api/health answers { status: ok } with no Origin', async () => {
  const res = await fetch(`${base}/api/health`);
  expect(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  expect(body.status === 'ok', `body ${JSON.stringify(body)}`);
});

await check('GET /.well-known/jwks.json publishes ES256 public keys only', async () => {
  const res = await fetch(`${base}/.well-known/jwks.json`);
  expect(res.status === 200, `status ${res.status}`);
  const cacheControl = res.headers.get('cache-control');
  expect(cacheControl === 'public, max-age=300', `Cache-Control: ${cacheControl}`);
  const { keys } = await res.json();
  expect(Array.isArray(keys) && keys.length > 0, 'no keys');
  for (const key of keys) {
    expect(key.kty === 'EC' && key.crv === 'P-256' && key.alg === 'ES256', `not an ES256 key: ${key.kid}`);
    expect(typeof key.kid === 'string' && key.kid.length > 0, 'a key has no kid');
    // The one that matters: `d` is the private half.
    expect(!('d' in key), `key ${key.kid} is published WITH its private half`);
  }
  return `kid: ${keys.map((key) => key.kid).join(', ')}`;
});

await check(`CORS preflight allows ${origin}, with credentials`, async () => {
  const res = await preflight(origin);
  const allowed = res.headers.get('access-control-allow-origin');
  expect(allowed === origin, `Access-Control-Allow-Origin: ${allowed} — is it in AUTH_PORTAL_ORIGINS?`);
  const credentials = res.headers.get('access-control-allow-credentials');
  expect(credentials === 'true', `Access-Control-Allow-Credentials: ${credentials}`);
});

await check('CORS preflight allows no other origin', async () => {
  const res = await preflight(FOREIGN_ORIGIN);
  const allowed = res.headers.get('access-control-allow-origin');
  expect(allowed === null, `Access-Control-Allow-Origin: ${allowed}`);
});

await check('a request with no Origin is 403', async () => {
  const res = await post('/api/auth/refresh');
  expect(res.status === 403, `status ${res.status}`);
});

await check('a request from another origin is 403', async () => {
  const res = await post('/api/auth/refresh', { from: FOREIGN_ORIGIN });
  expect(res.status === 403, `status ${res.status}`);
});

// 401, not 403: the origin has a portal, and what is missing is the session.
await check(`a refresh from ${origin} with no cookie is 401`, async () => {
  const res = await post('/api/auth/refresh', { from: origin });
  expect(res.status === 401, `status ${res.status}`);
});

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

if (!email || !password) {
  console.log('== 2. signing in: skipped (set SMOKE_EMAIL and SMOKE_PASSWORD to run it)');
} else {
  console.log(`== 2. signing in as ${email}`);

  let accessToken;
  let cookie;

  await check('POST /api/auth/login returns an access token and the refresh cookie', async () => {
    const res = await post('/api/auth/login', { from: origin, body: { email, password } });
    expect(res.status === 200, `status ${res.status}`);
    ({ accessToken } = await res.json());
    expect(typeof accessToken === 'string', 'no accessToken in the body');
    cookie = refreshCookie(res);
    expect(cookie !== null, `no ${REFRESH_COOKIE_NAME} cookie`);
  });

  if (accessToken && cookie) {
    await check('the cookie is HttpOnly, SameSite=Lax, Path=/api/auth and host-only', async () => {
      const has = (attribute) => cookie.attributes.includes(attribute);
      expect(has('httponly'), 'not HttpOnly');
      expect(has('samesite=lax'), 'not SameSite=Lax');
      expect(has('path=/api/auth'), 'not Path=/api/auth');
      expect(!cookie.attributes.some((a) => a.startsWith('domain=')), 'has a Domain, so it is not host-only');
      // A deployed cookie without Secure means AUTH_COOKIE_SECURE was left false.
      expect(!deployed || has('secure'), 'not Secure — set AUTH_COOKIE_SECURE=true');
    });

    // What billing compares its AUTH_ISSUER against, character for character.
    await check(`the token's iss is ${base}`, async () => {
      const claims = claimsOf(accessToken);
      expect(claims.iss === base, `iss is ${claims.iss} — AUTH_ISSUER is not this service's public URL`);
      return `aud: ${claims.aud}, account_type: ${claims.account_type}`;
    });

    await check('GET /api/me accepts the token', async () => {
      const res = await fetch(`${base}/api/me`, {
        headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status === 200, `status ${res.status}`);
      const me = await res.json();
      expect(me.email === email.toLowerCase(), `email ${me.email}`);
    });

    await check('POST /api/auth/refresh mints a new access token from the cookie', async () => {
      const res = await post('/api/auth/refresh', { from: origin, cookie: cookie.pair });
      expect(res.status === 200, `status ${res.status}`);
      const body = await res.json();
      expect(typeof body.accessToken === 'string', 'no accessToken in the body');
    });

    await check('POST /api/auth/logout is 204 and clears the cookie', async () => {
      const res = await post('/api/auth/logout', { from: origin, cookie: cookie.pair });
      expect(res.status === 204, `status ${res.status}`);
      const cleared = refreshCookie(res);
      expect(cleared !== null && cleared.value === '', 'the cookie was not cleared');
    });
  }
}

if (failed > 0) {
  console.log(`== ${failed} failed`);
  process.exit(1);
}
console.log('== all passed');
