# nest-foo-auth: standalone authentication service

Date: 2026-10-03
Status: approved 2026-10-03; amended during the build (section 17)
Repos: `nest-foo-auth` (this spec). Dependent work in `nest-foo-billing` and its
frontend is listed in section 13 and is not done from here.

Read alongside `nest-foo-billing/docs/superpowers/specs/2026-08-30-backend-owned-auth-design.md`
and the comments in `nest-foo-billing/src/auth/`. This spec does not repeat their
reasoning; where code moves unchanged, the comments move with it.

Section 15 lists every decision **I** made that was not in the brief. Everything
else marked **Decided** comes from the brief and is not re-opened here.

---

## 1. Goal

One sign-in for every portal. A user signs in once from either frontend and both
the billing and studio frontends are signed in. This service is the only issuer of
tokens; `nest-foo-billing` and `nest-foo-studio` only verify them. Every login is
recorded in a queryable, append-only log.

## 2. Topology (Decided)

```
 billing.<domain> (SPA) ──┐                      ┌── billing-api.<domain> (verify only)
                          ├── auth.<domain> ─────┤      │
 studio.<domain>  (SPA) ──┘   (this service)     └── studio-api.<domain>  (verify only)
                                   │                    │ fetch + cache JWKS
                                   └── GET /.well-known/jwks.json
                     one Postgres DB: foo_platform_db
                       schema auth   → owned by this repo
                       schema public → owned by billing (and later studio)
```

- All hosts share one registrable domain, so the frontends are *same-site* with
  `auth.<domain>` and a host-only `SameSite=Lax` cookie on the auth host is sent on
  their `fetch(..., { credentials: 'include' })` calls.
- Each frontend keeps its own login form and calls this service directly. No
  redirect flow.
- Real hostnames come from configuration only (section 10).

## 3. What moves from billing

| Billing file | Here | Change |
|---|---|---|
| `password.ts` (+spec) | `src/auth/password.ts` | none |
| `key-lockout.ts` (+spec) | `src/auth/key-lockout.ts` | none |
| `account-pin.ts` (+spec) | `src/auth/account-pin.ts` | none |
| `key-throttler.filter.ts` | `src/auth/key-throttler.filter.ts` | none |
| `user-admin.ts` (+spec) | `src/auth/user-admin.ts` | none |
| `session-cookie.ts` (+spec) | `src/auth/session-cookie.ts` | none in behaviour; see 6.3 |
| `dto/login.dto.ts`, `dto/key-login.dto.ts` | same | none |
| `public.decorator.ts`, `current-user.decorator.ts`, `authenticated-user.ts`, `auth-response.ts` | same | none |
| `session-token.ts` (+spec) | `src/auth/session-token.ts` | HS256 → ES256, new claims, portal audience (section 5) |
| `auth.service.ts` (+spec, +`auth-key.service.spec.ts`) | same | sid, portal, event writes (section 7) |
| `auth.controller.ts` (+`auth-key.controller.spec.ts`) | same | portal from origin, event writes |
| `jwt-auth.guard.ts` (+spec) | same | ES256 via local key set, audience from origin; `DISABLE_AUTH` removed |
| `auth.module.ts` | same | adds origin guard, JWKS controller, event service |
| `common/cors.ts` (+spec) | `src/common/cors.ts` | allowlist comes from the portal map (section 4) |
| `common/json-content-type.guard.ts` (+spec) | same | multipart opt-in removed (no uploads here) |
| `prisma/prisma.service.ts`, `prisma.module.ts` | same | none |
| `health/health.controller.ts` | same | none |
| `scripts/seed-admin.ts`, `user-add.ts`, `user-list.ts`, `set-key.ts`, `use-env.sh`, `install-git-hooks.mjs` | `scripts/` | boot a small script module instead of `AppModule` (15.9) |
| `test/create-test-app.ts`, `auth.e2e-spec.ts`, `auth-throttle.e2e-spec.ts`, `json-content-type.e2e-spec.ts`, `harness.spec.ts` | `test/` | send an `Origin`; e2e assertions on the new claims |

Stack is copied as-is: NestJS 11 (Express 5), Prisma 6, `jose`, `@node-rs/argon2`,
`@nestjs/throttler`, `cookie-parser`, `class-validator`/`class-transformer`,
vitest + `unplugin-swc` + supertest, Node 24 (`.nvmrc`), global prefix `api`,
`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`,
and the `.env` symlink scheme (`.env.local` / `.env.dev` / `.env.uat`,
`npm run env:*`) with separate `DATABASE_URL` (pooled) and `DIRECT_URL` (direct).

## 4. Portal from Origin (Decided, with details I added)

One config value maps browser origins to portals and is also the CORS allowlist:

```
AUTH_PORTAL_ORIGINS="https://billing.example.com=billing,https://studio.example.com=studio"
```

- Parsed and validated at boot. Each entry must be `origin=portal`, where `origin`
  equals `new URL(origin).origin` (scheme + host + port, no path, no trailing
  slash) and `portal` is `billing` or `studio`. Duplicate origins, an empty value,
  or an unknown portal stop the process. Several origins may map to one portal
  (e.g. two local dev ports).
- `PortalGuard` (global `APP_GUARD`, runs first) resolves `request.portal` from
  the `Origin` header on every route except those marked `@NoPortal()`. A missing
  or unrecognised origin gets **403** `{ statusCode: 403, error: 'Forbidden',
  message: 'Origin not allowed' }` before any credential is looked at (15.1).
- `@NoPortal()` applies only to `GET /.well-known/jwks.json` and `GET /api/health`,
  which are fetched server-to-server and carry no origin.
- The portal is **never** read from a body or query parameter. The DTOs keep
  `forbidNonWhitelisted`, so a `portal` field in a body is a 400.
- CORS reflects only allowlisted origins, `credentials: true`, methods
  `GET, POST, OPTIONS`, headers `Content-Type, Authorization`, and keeps
  `CORS_MAX_AGE` from billing.

CORS alone would not be enough: it stops a browser *reading* a response, not a
non-browser client sending the request. The guard is what actually refuses it.
Together with `JsonContentTypeGuard` it is also a second CSRF control on
`/auth/refresh`, which is the one endpoint that authenticates by cookie.

## 5. Tokens (Decided)

- **Algorithm:** ES256 only, signed with a P-256 private key that exists only in
  this service's environment. Pinned on verification here as well as in the
  product backends.
- **Key id:** every token header carries `kid`. The JWKS publishes the public half
  under the same `kid`.
- **Lifetimes:** access 15 minutes, refresh 12 hours (unchanged constants).

### 5.1 Claims

| Claim | Access token | Refresh token |
|---|---|---|
| `iss` | `AUTH_ISSUER` (this service's URL, e.g. `https://auth.example.com`) | same |
| `aud` | the portal: `billing` or `studio` | `AUTH_ISSUER` (15.2) |
| `sub` | account id (uuid) | same |
| `email` | account email | same |
| `sid` | session id, a uuid v4 minted at login | same |
| `typ` | `access` | `refresh` |
| `iat`, `exp` | set by `jose` | set by `jose` |

The refresh token is not bound to a portal. That is what makes single sign-on work:
the same cookie, sent from the studio origin, mints a `studio` access token. Its
`aud` is this service, so no product backend can accept it even if `typ` were
ignored.

### 5.2 Issuing and refreshing

- **Login (password or PIN):** mint `sid`; set the refresh cookie (`aud = issuer`,
  `sid`); return an access token with `aud = request.portal` and the same `sid`.
- **Refresh:** verify the cookie as a refresh token; return an access token with
  `aud = request.portal` and the `sid`, `sub`, `email` copied from it. No DB read
  for claims (unchanged reasoning). The refresh token is not re-issued, so a
  session still ends 12 hours after the password was typed (unchanged).

### 5.3 Key configuration and rotation

```
AUTH_SIGNING_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…","kid":"2026-10-a","alg":"ES256"}'
AUTH_PUBLISHED_JWKS='[]'   # extra public keys: rotation only
```

- `AUTH_SIGNING_JWK` is a private JWK on one line (15.3). Boot fails unless it is
  EC / P-256 with `d`, a non-empty `kid`, and `alg` absent or `ES256`.
- The JWKS is the public half of the signing key plus every key in
  `AUTH_PUBLISHED_JWKS` (public JWKs only; a `d` there fails boot; duplicate
  `kid`s fail boot).
- This service verifies refresh tokens (and `/me` access tokens) against that same
  local key set, never over HTTP.
- `npm run signing-key:generate` prints a new private JWK and its public JWK.

Rotation, "publish two keys, then drop the old one":

1. Add the **new** public JWK to `AUTH_PUBLISHED_JWKS`. Deploy. Wait at least the
   verifiers' JWKS cache age (section 8).
2. Swap `AUTH_SIGNING_JWK` to the new private key and put the **old** public JWK
   in `AUTH_PUBLISHED_JWKS`. Deploy.
3. After 12 h 15 min (longest refresh + one access lifetime), remove the old key.

## 6. Endpoints (Decided shapes)

All under the global prefix `api` except the JWKS. `PortalGuard` and
`JsonContentTypeGuard` apply everywhere except `@NoPortal()` routes.

| Method, path | Auth | Throttle | Success | Notes |
|---|---|---|---|---|
| `POST /api/auth/login` | public | `login` 10 / 15 min / IP | 200 `{ accessToken, user: { id, email } }` + cookie | body `LoginDto`; 401 `Invalid email or password` |
| `POST /api/auth/key` | public | same + `KeyThrottlerFilter` | 200, identical shape + cookie | body `KeyLoginDto`; 401 `{ message: 'Invalid key', attemptsRemaining }`; 429 `{ message: 'Too many attempts', retryAfter }` |
| `POST /api/auth/refresh` | refresh cookie | none | 200 `{ accessToken }` | 401 for any cookie problem |
| `POST /api/auth/logout` | public | none | 204, clears cookie | see 6.2 |
| `GET /api/me` | bearer access token, `aud` must equal `request.portal` | none | 200 `{ id, email }` | 401 for any token problem |
| `GET /.well-known/jwks.json` | public, `@NoPortal` | none | 200 `{ keys: [...] }` | `Cache-Control: public, max-age=300` |
| `GET /api/health` | public, `@NoPortal` | none | 200 `{ status: 'ok' }` | |

Status-code rules carried over: every token or credential failure is 401, never
403, with no hint about which check failed. The only 403 is the origin refusal in
section 4, which is a deployment error rather than a session state.

### 6.1 `/me` here

`/me` verifies the bearer token with `aud = request.portal`, so a studio token sent
from the billing origin is refused — the same audience rule the product backends
enforce. It returns the claims and does not read the database (unchanged).

### 6.2 Logout (Decided)

Clears the cookie, which signs the user out of every portal at once because there
is only one cookie. Issued access tokens live out their 15 minutes. No session
table, no revocation. If a valid refresh cookie came with the request, its `sub`
and `sid` are written to a `logout` event; an absent or invalid cookie still gets a
204 and writes nothing.

### 6.3 Refresh cookie (Decided)

Host-only on this service (no `Domain`), `HttpOnly`, `Secure`, `SameSite=Lax`,
`Path=/api/auth`, `Max-Age` 12 h. `session-cookie.ts` moves unchanged, including
its boot-time validation (`AUTH_COOKIE_SAMESITE` in `lax|strict|none`, `none`
requires `AUTH_COOKIE_SECURE=true`). Local development stays `secure=false`
because it runs over plain http. The name stays `cp_refresh` (15.10).

## 7. Login log: `auth.auth_event` (Decided, details mine where noted)

### 7.1 Table

```sql
CREATE TABLE auth.auth_event (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  account_id  UUID,                 -- no FK (15.5)
  kind        VARCHAR(32) NOT NULL,
  method      VARCHAR(16),
  portal      VARCHAR(16) NOT NULL,
  sid         UUID,
  ip          INET,
  user_agent  VARCHAR(512),         -- truncated, never rejected
  CONSTRAINT auth_event_kind_check   CHECK (kind IN ('login_success','login_failed','key_failed','key_locked','portal_entry','logout')),
  CONSTRAINT auth_event_method_check CHECK (method IS NULL OR method IN ('password','pin')),
  CONSTRAINT auth_event_portal_check CHECK (portal IN ('billing','studio'))
);
CREATE INDEX auth_event_account_id_created_at_idx ON auth.auth_event (account_id, created_at DESC);
CREATE INDEX auth_event_created_at_idx ON auth.auth_event USING brin (created_at);   -- retention sweep
CREATE UNIQUE INDEX auth_event_portal_entry_once ON auth.auth_event (sid, portal)
  WHERE kind = 'portal_entry';
```

Kinds, method and portal are `VARCHAR` + `CHECK` rather than Postgres enums
(15.4). The partial unique index and the CHECKs are raw SQL in the migration, like
`account_pin`'s CHECKs; the Prisma model documents that they exist.

### 7.2 What each kind means and when it is written

| kind | written by | account_id | method | sid |
|---|---|---|---|---|
| `login_success` | `/auth/login` or `/auth/key` success | yes | `password` / `pin` | new sid |
| `portal_entry` | login success **and** every refresh; insert-or-ignore | yes | null | yes |
| `login_failed` | `/auth/login` 401 | account if the email exists, else null | `password` | null |
| `key_failed` | `/auth/key` wrong key that does not lock | door holder, or null if no key set | `pin` | null |
| `key_locked` | `/auth/key` wrong key that *starts* a lockout | door holder or null | `pin` | null |
| `logout` | `/auth/logout` with a valid refresh cookie | yes | null | yes |

- **`portal_entry` once per `(sid, portal)`.** Written with `createMany({ data,
  skipDuplicates: true })`, which is `INSERT … ON CONFLICT DO NOTHING` and is
  satisfied by the partial unique index. Login writes it for the portal the user
  signed in from (15.6), so "which portals did this session enter" is one query
  over `portal_entry`. Every later refresh tries again and is a no-op after the
  first one per portal.
- **Not recorded:** requests refused while locked (they never reach a verify),
  throttle 429s, origin 403s, validation 400s, failed refreshes (15.7).
- **Never stored:** passwords, PINs, tokens, or the email typed on a failure.
- **IP and user agent** come from `req.ip` and `User-Agent`. `TRUST_PROXY` must be
  set when deployed behind a proxy, or every IP is the proxy's (and the login
  throttle becomes one global budget — both already true in billing).

### 7.3 Writing the log must not change a failed login

- Every failure path writes its row and **then** throws the same exception it
  throws today. Unknown email and wrong password both do one Argon2 verify, one
  insert, one 401 with the same body, so the insert costs the same on both paths.
- The insert is awaited (so the cost is uniform, and rows are not lost on
  shutdown) but wrapped: a failed insert logs a warning and is swallowed. A
  logging failure never turns a 401 into a 500, and never blocks a successful
  login (15.8).
- On success, `login_success` and `portal_entry` go in one `createMany`.

### 7.4 Example queries

```sql
-- Last 20 sign-ins for one account
SELECT created_at, kind, method, portal, ip FROM auth.auth_event
WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20;

-- Which portals each session reached, and when
SELECT sid, portal, created_at FROM auth.auth_event
WHERE kind = 'portal_entry' AND account_id = $1 ORDER BY created_at DESC;

-- Failed password attempts by IP in the last day
SELECT ip, count(*) FROM auth.auth_event
WHERE kind = 'login_failed' AND created_at > now() - interval '1 day'
GROUP BY ip ORDER BY 2 DESC;
```

### 7.5 Retention: about 12 months (proposal)

- `AuthEventRetention` deletes rows older than `AUTH_EVENT_RETENTION_DAYS`
  (default 365) in batches of 5,000 until a batch deletes nothing:
  `DELETE FROM auth.auth_event WHERE id IN (SELECT id … WHERE created_at < $cutoff LIMIT 5000)`.
- It runs once shortly after boot and then every 24 h on an `unref`'d timer. No new
  dependency, no external scheduler. It is idempotent, so two instances running
  it together is harmless. Short-lived containers still sweep because every boot
  sweeps.
- The same function is exposed as `npm run events:prune` for a manual run.
- Rejected: `pg_cron` (Neon runs it only while the compute is awake, so it misses
  runs on an auto-suspended branch), and table partitioning (worth it at millions
  of rows a month, not at this volume).

## 8. Contract for the product backends (to be built in those repos)

Each product backend carries a small verify-only guard:

1. **Fetch and cache the JWKS** from `AUTH_JWKS_URL`
   (`https://auth.<domain>/.well-known/jwks.json`). With `jose`,
   `createRemoteJWKSet(new URL(AUTH_JWKS_URL))` does this: it caches, and re-fetches
   when a token carries an unknown `kid` (cooldown 30 s, max age 10 min by
   default). Keep the cache max age at or below 10 minutes so step 1 of rotation
   only needs a 10-minute wait.
2. **Accept ES256 only:** `algorithms: ['ES256']`.
3. **Require** `iss === AUTH_ISSUER`, `aud === '<own portal>'` (`billing` or
   `studio`), and `typ === 'access'`. A `typ: refresh` token, a token for the other
   portal, or any other issuer is a 401.
4. **Read** `sub` (account id, string), `email` (string), `sid` (uuid string).
   Require all three to be non-empty strings; otherwise 401. Since the
   account-types change, also read `account_type` and, for clients,
   `client_id`. See `2026-10-03-account-types-design.md` section 5.
5. Bearer header only (`Authorization: Bearer <jwt>`), never a cookie. Every
   failure is a 401, never a 403, with no reason in the body — the rule billing's
   guard already documents.
6. Clock tolerance: none needed beyond `jose`'s default; if one is added keep it at
   5 s or less.

Reference implementation for the spec (not shipped from here):

```ts
const jwks = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL));
const { payload } = await jwtVerify(token, jwks, {
  algorithms: ['ES256'],
  issuer: config.AUTH_ISSUER,
  audience: 'billing',
});
if (payload.typ !== 'access') throw new UnauthorizedException();
// sub, email, sid: non-empty strings, else 401
```

`test/contract.e2e-spec.ts` in this repo runs exactly this snippet against tokens
the service issues, so the contract is tested here, not just written down.

## 9. Data model and migrations

### 9.1 Schema `auth`, own migration history

- `DATABASE_URL` and `DIRECT_URL` both carry `?schema=auth` (plus the existing
  `sslmode`/`channel_binding` on Neon). Prisma then:
  - schema-qualifies every query it generates (`"auth"."account"`), so it does not
    depend on `search_path` — which matters, because Neon's pooler runs PgBouncer in
    transaction mode and does not keep a `SET search_path`;
  - creates its migration table as `auth._prisma_migrations`, separate from
    billing's `public._prisma_migrations`. This is what gives this repo its own
    history without `multiSchema`.
- Raw SQL in this repo (`$executeRaw`, the retention delete) always schema-qualifies
  `auth.` explicitly.
- Billing and studio never read `auth.*` (Decided). Enforcing that with a separate
  Postgres role is listed in section 16 as a follow-up.

### 9.2 Models

`Account` and `AccountPin` are copied from billing's schema unchanged (columns,
types, `@map`s, comments, `Restrict` FK, `@unique` on `accountId`). `AuthEvent` is
new and mirrors 7.1; the Prisma model has `@@index([accountId, createdAt(sort:
Desc)])` and `@@index([createdAt], type: Brin)`, with a comment pointing at the
CHECKs and the partial index that only exist in SQL.

### 9.3 Migrations

1. `0_init` — describes `account` and `account_pin` **exactly as they exist in
   billing today**: same column types, constraint and index names
   (`account_pkey`, `account_email_key`, `account_pin_pkey`,
   `account_pin_account_id_key`, `account_pin_account_id_fkey`), both CHECKs
   (`account_pin_singleton` `id = 1`, `account_pin_pairing`), and the singleton seed
   row. It begins with a guard that raises a readable error if `auth.account`
   already exists ("this database came from billing; baseline instead"), so running
   it by mistake fails loudly instead of half-applying.
   Generated with `prisma migrate diff --from-empty --to-schema-datamodel`, then
   the CHECKs, seed and guard added by hand.
2. `<ts>_add_auth_event` — the table from 7.1, generated, then the CHECKs and the
   partial index added by hand.

Any database that has billing's history gets `0_init` **resolved, never run**. Only
an empty database (this repo's tests, a scratch DB) runs it.

## 10. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `APP_ENV` | no | boot log label (unchanged) |
| `PORT` | no | default 3001 (billing is 3000) |
| `DATABASE_URL` | yes | pooled, `?schema=auth` |
| `DIRECT_URL` | yes | direct, `?schema=auth`, used by `prisma migrate` |
| `AUTH_ISSUER` | yes | `iss`, e.g. `https://auth.example.com`; must parse as a URL |
| `AUTH_SIGNING_JWK` | yes | private P-256 JWK with `kid` |
| `AUTH_PUBLISHED_JWKS` | no | JSON array of extra public JWKs (rotation) |
| `AUTH_PORTAL_ORIGINS` | yes | `origin=portal,…`; also the CORS allowlist |
| `AUTH_COOKIE_SECURE`, `AUTH_COOKIE_SAMESITE` | no | unchanged validation; deployed values `true` / `lax` |
| `CORS_MAX_AGE` | no | unchanged |
| `TRUST_PROXY` | when proxied | client IP for throttle and log |
| `AUTH_EVENT_RETENTION_DAYS` | no | default 365 |
| `ADMIN_*`, `USER_*`, `OPERATOR_*` | scripts only | unchanged |

Removed relative to billing: `AUTH_JWT_SECRET`, `CORS_ORIGINS`, `DISABLE_AUTH`,
`R2_*`. Every required variable is read with `getOrThrow` or validated in a
constructor, so a bad value fails at boot (unchanged principle).

## 11. Handing the tables over from billing

### 11.1 Mechanism

`ALTER TABLE … SET SCHEMA auth` moves a table without copying rows. Postgres keeps
its constraints (including both CHECKs and PG17+ named NOT NULLs), indexes and the
FK between the two tables, because they belong to the table, not the schema.
Neither table owns a sequence (`account.id` is a client-side uuid, `account_pin.id`
defaults to the literal 1), so nothing is left behind in `public`.

**Where the move SQL lives (15.11).** In deployed environments the `ALTER` statements
should ship as a hand-written **billing** migration, not be run by hand. Reason:
once billing drops the two models, `prisma migrate dev` in billing replays its
history into a shadow DB, finds `account` there, and generates a `DROP TABLE`
unless its own history says the tables left. A billing migration that moves them is
exactly that statement, and applying it is the move. The runbook below rehearses
the same SQL by hand so it can be tested from this repo without touching billing.

### 11.2 What must be verified before relying on it

Checked during the build against local Postgres and, with your OK, the Neon dev
branch. Each is a step in the runbook.

1. After the move, `prisma migrate resolve --applied 0_init` over `DIRECT_URL`
   writes `auth._prisma_migrations` and leaves `public._prisma_migrations`
   untouched.
2. `prisma migrate diff --from-schema-datasource prisma/schema.prisma
   --to-schema-datamodel prisma/schema.prisma --exit-code` reports no drift for the
   moved tables.
3. Prisma's diff does not try to drop `auth_event_portal_entry_once` (it cannot
   represent a partial index). If it does, the fallback is a full unique index on
   `(sid, portal, kind)` — safe because every kind other than `portal_entry`
   either has a null `sid` or occurs once per `(sid, portal)` — expressed as
   `@@unique` with no raw SQL.
4. Both CHECKs are still present (`pg_constraint`), and violating each one fails.
5. The service, on the **pooled** URL, can log in, refresh, and insert-or-ignore
   `portal_entry` — i.e. schema qualification works through PgBouncer.
6. Billing's Prisma diff (schema `public`) shows no drift after the move, given its
   models are gone. (Read-only check, run from billing's directory with its
   current code; no billing files changed.)

### 11.3 Runbook (rehearse first; local or dev only)

Lives at `docs/runbooks/auth-table-handover.md` after the rehearsal. Outline:

0. **Snapshot.** Local: `pg_dump -Fc`. Neon: create a branch from the target and
   rehearse on that branch first.
1. **Pre-checks.** `account` and `account_pin` exist in `public`; `auth` schema has
   no tables; `account_pin` has exactly one row; record row counts.
2. **Move** (over `DIRECT_URL`, one transaction, `lock_timeout = '5s'`):
   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   CREATE SCHEMA IF NOT EXISTS auth;
   ALTER TABLE public.account_pin SET SCHEMA auth;
   ALTER TABLE public.account     SET SCHEMA auth;
   COMMIT;
   ```
3. **Baseline:** `npx prisma migrate resolve --applied 0_init`.
4. **Forward:** `npx prisma migrate deploy` (creates `auth_event`).
5. **Verify:** 11.2 items 2–6; row counts match step 1.
6. **Smoke:** start the service against the DB; log in, refresh from both portal
   origins, check the `auth_event` rows.
7. **Rollback** (only before billing's new release is live):
   ```sql
   BEGIN;
   DROP TABLE auth.auth_event;
   ALTER TABLE auth.account     SET SCHEMA public;
   ALTER TABLE auth.account_pin SET SCHEMA public;
   DROP TABLE auth._prisma_migrations;
   DROP SCHEMA auth;
   COMMIT;
   ```

### 11.4 Cutover order (UAT and production — not run without asking you)

1. Deploy this service to `auth.<domain>`. It cannot serve logins yet; that is fine.
2. Release billing: its migration moves the tables; its new guard verifies ES256 via
   the JWKS. Old billing instances fail logins during the rollout — a window of
   minutes, accepted because ES256 ends every session at this point anyway.
3. Here: `migrate resolve --applied 0_init`, then `migrate deploy`.
4. Release the billing frontend repointed at `auth.<domain>`.
5. Everyone signs in again (accepted).

## 12. Testing

Test-first, vitest, no database for the default suite: endpoint tests boot the real
`AppModule` via `createTestApp` (configured exactly like `main.ts`) and override
`PrismaService` with a stub, as billing does.

**Ported, kept passing:** `password`, `key-lockout`, `account-pin`, `user-admin`,
`session-cookie`, `session-token`, `jwt-auth.guard`, `auth.service`,
`auth-key.service`, `auth-key.controller`, `cors`, `json-content-type.guard`,
`auth.e2e`, `auth-throttle.e2e`, `json-content-type.e2e`, `harness`. Changes are
limited to: an `Origin` header on requests, an ES256 test key instead of the HS256
secret, and new claim assertions. Behavioural expectations do not move.

**New:**

- **JWKS endpoint:** returns the signing key's public JWK with `kid`, `alg: ES256`,
  `use: sig`, and no `d`; includes `AUTH_PUBLISHED_JWKS`; no origin needed;
  `Cache-Control` set; a token signed by the service verifies against the served
  JWKS.
- **Origin to portal:** config parsing (valid, duplicates, bad portal, path or
  trailing slash, empty); login from each origin gets the right `aud`; missing
  origin and unknown origin get 403 and never reach the credential check; a
  `portal` body field is 400; CORS reflects only allowlisted origins.
- **Audience separation:** a studio access token is rejected by a billing verifier
  (the section 8 snippet) and by `/me` called from the billing origin; a refresh
  token is rejected by both; a token signed with a different key or with HS256 is
  rejected.
- **SSO:** sign in from billing, refresh from the studio origin with the same
  cookie, receive a `studio` token with the same `sid`.
- **`portal_entry` once per session:** unit level — login writes `login_success` +
  `portal_entry`, refresh calls insert-or-ignore; DB level — an opt-in suite
  (`test/db/*.int-spec.ts`, runs when `TEST_DATABASE_URL` is set, skipped
  otherwise) applies the migrations to a throwaway database and shows that
  repeated refreshes from one portal leave exactly one row per `(sid, portal)`,
  while a second portal adds one more.
- **Log does not change failures:** unknown email and wrong password still give
  byte-identical 401 bodies with the log writer present; a throwing log writer
  still gives the same 401 (and a successful login still succeeds); no event row
  contains the typed email, password, PIN or a token.
- **Contract:** `test/contract.e2e-spec.ts` (section 8).
- **Retention:** the cutoff and batching loop against the stub; the SQL against
  the opt-in DB suite.

## 13. Dependencies in `nest-foo-billing` (separate work, not done here)

1. Hand-written migration moving `account` and `account_pin` to schema `auth`
   (section 11.1), with a guard that refuses to run if `auth.account` already
   exists. Drop both models from `schema.prisma` in the same change.
2. Replace `JwtAuthGuard` with the verify-only guard from section 8
   (`aud = 'billing'`). Keep `@Public()`, `@CurrentUser()` and `AuthenticatedUser`.
   Its `/me`, if kept, returns `{ id, email }` from the token.
3. Remove `AuthController`, `AuthService`, the PIN, throttler, cookie and password
   code, the admin scripts and their npm scripts, and their specs.
4. Env: remove `AUTH_JWT_SECRET`, `AUTH_COOKIE_*`, `ADMIN_*`, `USER_*`,
   `OPERATOR_*`; add `AUTH_ISSUER`, `AUTH_JWKS_URL`.
5. Test helpers that sign tokens switch to a local ES256 key and a local JWKS.
6. Frontend: login, key, refresh and logout go to `auth.<domain>` with
   `credentials: 'include'`; the access token is attached to billing API calls as
   today; response types unchanged.

## 14. Out of scope (Decided)

Sign-up, email verification, password reset, roles, per-portal grants, a session
table, server-side revocation, a shared npm guard package, anything in the studio
repo, and running anything against UAT or production.

---

## 15. Decisions I made (please review)

1. **Unknown/missing origin → 403**, not 401. It is a deployment fault, not a
   session state, and the "always 401" rule exists so the frontend signs out on
   401 — a misconfigured origin should not look like a sign-out. Applies to every
   route except JWKS and health, including `/me` and `/logout`.
2. **Refresh token `aud` = `AUTH_ISSUER`**, not a portal. It has to work from both
   portals, and this makes it unusable at any product backend.
3. **Signing key as a one-line private JWK** in env rather than PEM, to avoid
   multi-line env values; `kid` travels inside it.
4. **`VARCHAR` + `CHECK` instead of Postgres enums** for `kind`, `method`,
   `portal`. Adding a value later is one `ALTER TABLE` rather than `ALTER TYPE`,
   and it avoids any question of enum casts through `?schema=auth`. TypeScript
   union types give the same safety in code.
5. **`account_id` has no foreign key.** An audit row should outlive the account it
   describes and should never block account admin. `ON DELETE SET NULL` would
   erase who it was.
6. **Login also writes `portal_entry`** for the portal signed in from, so
   "portals a session entered" is one query, and the first refresh from that same
   portal is a no-op.
7. **What is not logged:** refusals while locked, throttled 429s, origin 403s,
   400s, failed refreshes. `key_locked` means "this attempt started a lockout",
   written instead of `key_failed` for that attempt.
8. **Log writes are awaited but never fatal.** Uniform timing and no lost rows on
   shutdown; a DB hiccup on the log does not block a login or change a 401.
9. **Admin scripts boot a small `ScriptsModule`** (config + Prisma only) instead
   of the whole app, so running `user:add` does not require the signing key or
   origin map.
10. **Cookie name stays `cp_refresh`.** It lives on a new host, so it cannot clash
    with billing's old cookie, and nothing reads it by name outside this service.
11. **The move SQL ships as a billing migration** in real environments (11.1).
12. **`DISABLE_AUTH` is dropped here.** An issuer with an auth bypass has no use.
13. **`timestamptz` for `auth_event.created_at`**, unlike the existing
    `TIMESTAMP(3)` columns, because log rows are compared across time zones and
    against `now()`. `account` and `account_pin` keep their types untouched.
14. **Retention runs in-process** (boot + 24 h timer), plus `npm run events:prune`.
15. **Opt-in DB test suite** for the rules only Postgres can prove (partial unique
    index, CHECKs, retention SQL). The default suite stays database-free.
16. **PORT 3001** by default.

## 16. Open questions and follow-ups

- **Role separation.** Today all three services probably connect as one Postgres
  role, so "billing never reads `auth.*`" is a convention. A dedicated `auth_svc`
  role owning schema `auth`, with `USAGE` revoked from billing's role, would
  enforce it. Not in this work; worth doing before studio exists.
- **Rehearsal on Neon dev.** I will rehearse on local Postgres first. May I also
  run the runbook against a **new Neon branch created from dev** (not dev itself)?
  It proves item 11.2.5 (the pooled connection) in the real setting.
- **Commit convention.** Billing's plan says no `Co-Authored-By` trailer in that
  repo. Same rule here? And should I commit on a branch in this repo, or leave the
  work uncommitted for you?

  **Answered 2026-10-07.** Not the same rule: work authored with Claude carries a
  `Co-Authored-By` trailer, because the tool doing the authoring requires one. And
  commit on a branch — every change lands by pull request now, since `development`,
  `uat` and `main` are protected and need a green CI run to merge (FA-18).
- **Throttle storage.** The login throttle is in-memory per instance (unchanged).
  If this service runs more than one instance, the effective limit is per
  instance. Fine for now; a Redis store is the fix if it scales out.

## 17. Amendments during the build

Recorded here rather than silently changed above.

1. **`auth_event.id` is `BIGSERIAL`**, not an identity column: it is what Prisma
   generates for `BigInt @default(autoincrement())`, and hand-writing identity
   would show as drift on every diff. No behavioural difference.
2. **`AuthService` also guards its own log calls.** `AuthEventService` already
   swallows failures; a second catch in `AuthService` makes "the log never
   changes an answer" hold even against a misbehaving recorder, and a test pins
   it.
3. **One wiring function.** `configureApp()` in `src/app-setup.ts` is called by
   both `main.ts` and the test app, instead of billing's two hand-kept copies.
4. **Global guard order is explicit.** All three `APP_GUARD`s are registered in
   `AppModule` in order: `PortalGuard`, `JsonContentTypeGuard`, `JwtAuthGuard`.
5. **Retention's first sweep runs a minute after boot**, not "shortly", so a
   cold start is never slowed by it.
6. **Rehearsal results** are in `docs/runbooks/auth-table-handover.md`. Items
   11.2.4 (CHECKs kept) and the structural half of 11.2.2 are proven on copies
   of local (PG16) and Neon dev (PG18). Items 11.2.1, 11.2.3, 11.2.5 and the
   Prisma half of 11.2.2 need a real Prisma engine, which the cloud workspace
   cannot download; `scripts/handover/rehearse.sh` closes them on a machine
   that can.
