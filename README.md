# nest-foo-auth

The one place sign-in happens for the foo platform. Issues ES256 tokens for the
**billing** and **studio** portals, owns the `auth` schema of
`foo_platform_db`, and publishes the public key the product backends verify
with. Sign in at one portal and you are signed in at every portal your account
may enter.

Two account types: **staff** may enter billing and studio. A **client** belongs
to one billing client and may enter studio only, where it sees only that
client's data ([spec](docs/superpowers/specs/2026-10-03-account-types-design.md)).

Design: [`docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md`](docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md).
Moving the tables over from billing: [`docs/runbooks/auth-table-handover.md`](docs/runbooks/auth-table-handover.md).

## Endpoints

All need an `Origin` listed in `AUTH_PORTAL_ORIGINS`, which decides the portal;
anything else is a 403. Except where noted, mutating requests must send
`Content-Type: application/json`.

| | | Returns |
|---|---|---|
| `POST /api/auth/login` | `{ email, password }`, throttled 10/15 min/IP | `{ accessToken, user: { id, email, accountType, clientId? } }` + refresh cookie; 403 for a client at billing |
| `POST /api/auth/key` | `{ key }` (six digits), throttled + per-door lockout | same as login |
| `POST /api/auth/refresh` | refresh cookie | `{ accessToken }` for the requesting portal; 403 for a client at billing, 401 once disabled |
| `POST /api/auth/logout` | — | 204, cookie cleared (signs out of every portal) |
| `GET /api/me` | `Authorization: Bearer <access token for this portal>` | `{ id, email, accountType, clientId? }` |
| `GET /.well-known/jwks.json` | no Origin needed | the public signing keys |
| `GET /api/health` | no Origin needed | `{ status: 'ok' }` |

Access tokens last 15 minutes, the refresh cookie 12 hours. Claims: `iss`,
`aud` (`billing` | `studio`), `sub`, `email`, `sid`, `typ`, `account_type`
(`staff` | `client`), and `client_id` for client logins. The contract the
product backends verify against is spec section 8, and
`test/contract.e2e-spec.ts` runs it.

## Hostnames

Decided 2026-10-07 (FA-13). Every host is under `foocertong.com`, so each
frontend is same-site with its auth host and the browser sends the host-only
`SameSite=Lax` refresh cookie.

| Environment | Auth (this service) | Billing frontend |
|---|---|---|
| Production | `auth-api.foocertong.com` | `billing.foocertong.com` |
| UAT | `auth-api-uat.foocertong.com` | `billing-uat.foocertong.com` |
| Development | `auth-api-dev.foocertong.com` | `billing-dev.foocertong.com` |

What follows from that, shown for production (swap the hosts for UAT and
development):

| Where | Variable | Value |
|---|---|---|
| nest-foo-auth | `AUTH_ISSUER` | `https://auth-api.foocertong.com` |
| nest-foo-auth | `AUTH_PORTAL_ORIGINS` | `https://billing.foocertong.com=billing` |
| nest-foo-billing | `AUTH_ISSUER` | the same string as above, character for character |
| nest-foo-billing | `AUTH_JWKS_URL` | `https://auth-api.foocertong.com/.well-known/jwks.json` |
| react-foo-billing | `VITE_AUTH_URL` | `https://auth-api.foocertong.com` |

The studio origin joins `AUTH_PORTAL_ORIGINS` when studio exists. A frontend on
`localhost` is cross-site with a deployed auth host, so the cookie will not come
back: for local work, run this service locally on port 3001.

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

## Branches and CI

Decided 2026-10-07 (FA-18). The same three branch names as nest-foo-billing,
deliberately, so that one sentence describes where a change is in both services:

    feature branch -> development -> uat -> main

`development` is the default branch, so a pull request opened without saying
otherwise targets it. `feat/standalone-auth-service`, the branch this service
was built on, was merged and then deleted on 2026-10-07; its commits are in the
history of all three branches, so nothing is lost by its absence. Only the three
above exist on the remote.

All three are protected by one ruleset (`protected branches (development, uat,
main)`) rather than three separate rules, so they cannot drift apart: a merge
needs a pull request and a green CI run, force pushes are refused, and the
branches cannot be deleted. The bypass list is empty, so this applies to the
repository owner too — an emergency push during a cut-over needs a bypass entry
added on purpose first.

Required approvals is **0**, which is not an oversight: there is one contributor,
and GitHub will not let anyone approve their own pull request, so requiring one
would leave every branch unmergeable. CI passing is the gate. Raise it to 1 as
soon as a second person has write access.

`.github/workflows/ci.yml` runs on every pull request and on every push to the
three branches, on the Node version in `.nvmrc` (via `node-version-file`, so the
version is pinned in one place). Three jobs, all three required to merge:

| Job | What it proves |
|---|---|
| `types, tests, build` | `tsc --noEmit`, `npm test`, `npm run build` |
| `database suite` | `npm run test:db` against a real Postgres 18 service — the partial unique index, the CHECKs and the retention DELETE |
| `docker build` | the production image builds |

The database job sets `TEST_DATABASE_URL` explicitly. Without it every case in
that suite skips itself and the job still goes green, which is the exact failure
it exists to prevent.

## Accounts

| | |
|---|---|
| `npm run seed:admin` | create a staff account, or reset a staff password (there is no reset flow) |
| `npm run user:add` | add an account; `USER_ACCOUNT_TYPE=client USER_CLIENT_ID=<billing client id>` for a client |
| `npm run user:list` | list accounts with type, client, disabled, and the PIN holder |
| `npm run user:disable` / `user:enable` | cut a login off (its session ends within 15 minutes) or let it back |
| `npm run key:set` | set, move or clear the six-digit PIN (staff only); also the unlock |

## The login log

`auth.auth_event`, append-only. One row per `login_success`, `login_failed`,
`key_failed`, `key_locked`, `portal_denied`, `logout`, and one `portal_entry`
per session per portal. Never a password, PIN, token or typed email. Kept 365 days
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
