# nest-foo-auth

The one place sign-in happens for the foo platform. Issues ES256 tokens for the
**billing** and **studio** portals, owns the `auth` schema of
`foo_platform_db`, and publishes the public key the product backends verify
with. Sign in at one portal and you are signed in at both.

Design: [`docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md`](docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md).
Moving the tables over from billing: [`docs/runbooks/auth-table-handover.md`](docs/runbooks/auth-table-handover.md).

## Endpoints

All need an `Origin` listed in `AUTH_PORTAL_ORIGINS`, which decides the portal;
anything else is a 403. Except where noted, mutating requests must send
`Content-Type: application/json`.

| | | Returns |
|---|---|---|
| `POST /api/auth/login` | `{ email, password }`, throttled 10/15 min/IP | `{ accessToken, user: { id, email } }` + refresh cookie |
| `POST /api/auth/key` | `{ key }` (six digits), throttled + per-door lockout | same as login |
| `POST /api/auth/refresh` | refresh cookie | `{ accessToken }` for the requesting portal |
| `POST /api/auth/logout` | — | 204, cookie cleared (signs out of every portal) |
| `GET /api/me` | `Authorization: Bearer <access token for this portal>` | `{ id, email }` |
| `GET /.well-known/jwks.json` | no Origin needed | the public signing keys |
| `GET /api/health` | no Origin needed | `{ status: 'ok' }` |

Access tokens last 15 minutes, the refresh cookie 12 hours. Claims: `iss`,
`aud` (`billing` | `studio`), `sub`, `email`, `sid`, `typ`. The contract the
product backends verify against is spec section 8, and
`test/contract.e2e-spec.ts` runs it.

## Running it

```bash
npm install
cp .env.example .env.local      # then fill it in; see the comments
npm run env:local
npm run signing-key:generate    # paste AUTH_SIGNING_JWK into .env.local
npx prisma migrate deploy       # on a database that came from billing, follow the runbook instead
npm run seed:admin              # ADMIN_EMAIL / ADMIN_PASSWORD
npm run start:dev               # http://localhost:3001
```

## Tests

```bash
npm test                        # no database needed
TEST_DATABASE_URL=postgresql://foo:PASSWORD@localhost:5432/postgres npm run test:db
```

`test:db` creates a throwaway database beside the one named, migrates it, runs
the rules only Postgres can prove (one `portal_entry` per session per portal,
the CHECKs, retention), and drops it.

## Accounts

| | |
|---|---|
| `npm run seed:admin` | create an account, or reset its password (there is no reset flow) |
| `npm run user:add` | add an account; refuses an existing email |
| `npm run user:list` | list accounts and which one holds the PIN |
| `npm run key:set` | set, move or clear the six-digit PIN; also the unlock |

Every account may enter every portal. There are no roles.

## The login log

`auth.auth_event`, append-only. One row per `login_success`, `login_failed`,
`key_failed`, `key_locked`, `logout`, and one `portal_entry` per session per
portal. Never a password, PIN, token or typed email. Kept 365 days
(`AUTH_EVENT_RETENTION_DAYS`); pruned a minute after boot and daily, or with
`npm run events:prune`. Set `TRUST_PROXY=1` behind a proxy or every IP is the
proxy's. Example queries: spec section 7.4.

## Rotating the signing key

1. `SIGNING_KEY_ID=<new kid> npm run signing-key:generate`. Put the **public** JWK
   in `AUTH_PUBLISHED_JWKS` (`[ {...} ]`). Deploy. Wait 10 minutes, the longest a
   verifier caches the JWKS.
2. Set `AUTH_SIGNING_JWK` to the new **private** JWK, and replace
   `AUTH_PUBLISHED_JWKS` with the **old** key's public JWK. Deploy.
3. After 12 h 15 min, empty `AUTH_PUBLISHED_JWKS`. Deploy.
