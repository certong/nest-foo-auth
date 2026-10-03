# nest-foo-auth implementation plan

**Spec:** `docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md` (approved
2026-10-03, including every decision in its section 15). This plan implements it
and does not restate its reasoning.

**Goal:** a standalone NestJS service that is the only issuer of ES256 tokens for
the billing and studio portals, owns `auth.account`, `auth.account_pin` and the
new `auth.auth_event`, and publishes a JWKS the product backends verify against.

**Architecture:** billing's `src/auth` moves across nearly unchanged. Three new
pieces sit around it: `TokenKeys` (signing key, JWKS and the local verification
key set, built once at boot), `PortalGuard` (origin → portal, global, runs first)
and `AuthEventService` (best-effort, awaited inserts into the log). `AuthService`
gains a `sid` and a portal; nothing else about its security logic moves.

## Global constraints

- NestJS 11 / Express 5, Prisma 6.19, `jose` 6, `@node-rs/argon2`,
  `@nestjs/throttler` 6, vitest 4 + `unplugin-swc`. Node 24 (`.nvmrc`).
- Global prefix `api`, excluded only for `GET /.well-known/jwks.json`.
- `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- App wiring lives in **one** function, `configureApp(app)` in `src/app-setup.ts`,
  called by both `main.ts` and `test/create-test-app.ts`, so the tested app cannot
  differ from the deployed one (billing duplicated this by hand).
- Response shapes are frozen: login/key `{ accessToken, user: { id, email } }`,
  refresh `{ accessToken }`, `/me` `{ id, email }`. `sid` never appears in a body.
- Every token or credential failure is 401 with no reason. The only 403 is the
  origin refusal.
- Fixed values: access TTL `15 * 60`, refresh TTL `12 * 60 * 60`, cookie
  `cp_refresh` at path `/api/auth`, login throttle 10 per 900 000 ms, messages
  `Invalid email or password`, `Invalid key`, `Too many attempts`,
  `Origin not allowed`.
- Raw SQL always writes `auth.` explicitly.
- Default test suite needs no database (`PrismaService` is stubbed). The DB
  suite (`npm run test:db`) runs only when `TEST_DATABASE_URL` is set.
- Commits: feature branch `feat/standalone-auth-service`, no `Co-Authored-By`
  trailer.

## Sandbox note (for whoever runs this plan from the cloud workspace)

`binaries.prisma.sh` is blocked there. `prisma generate` works with
`PRISMA_QUERY_ENGINE_LIBRARY` pointed at a placeholder file, which is enough for
the stubbed suite. The DB suite and the Prisma-level handover checks need a real
engine and run on the developer machine (or once the domain is allowed).

---

## Task 1 — Scaffold and harness

**Files:** `package.json` (from billing: name, scripts, minus R2/seed; plus
`signing-key:generate`, `events:prune`, `test:db`), `package-lock.json`,
`tsconfig*.json`, `nest-cli.json`, `vitest.config.mts`, `.nvmrc`,
`.gitattributes`, `.gitignore`, `.dockerignore`, `Dockerfile` (port 3001),
`.githooks/*`, `scripts/install-git-hooks.mjs`, `scripts/use-env.sh`,
`test/harness.spec.ts`.

- [x] Copy, adjust, `npm install`, `prisma generate`.
- [x] `npm test` runs `harness.spec.ts` green (proves decorator metadata survives).

## Task 2 — Schema, migrations, handover SQL (done during rehearsal)

**Files:** `prisma/schema.prisma`, `prisma/migrations/0_init`,
`prisma/migrations/20261003120000_add_auth_event`, `migration_lock.toml`,
`scripts/handover/{00-precheck,10-move,30-verify,90-rollback}.sql`.

- [x] Rehearsed on copies of local (PG16) and Neon dev (PG18): precheck, move,
  verify, rule probes, rollback; moved tables structurally identical to a fresh
  `0_init` + `add_auth_event` build (columns, constraint and index names, both
  CHECKs, FK, PG18 NOT NULL names). **Done.**
- [x] Prisma-level checks (resolve writes `auth._prisma_migrations`, no drift,
  partial index not dropped) — **done locally 2026-10-03**.
- [ ] Pooled connection — on the Neon cutover rehearsal branch.

## Task 3 — Port the unchanged modules and their specs

**Files (copied verbatim):** `src/auth/{password,key-lockout,account-pin,user-admin,
key-throttler.filter,public.decorator,current-user.decorator,authenticated-user,
auth-response,session-cookie}.ts`, `src/auth/dto/*`, their specs,
`src/prisma/*`, `src/health/health.controller.ts`.

- [x] Specs green with no edits: `password`, `key-lockout`, `account-pin`,
  `user-admin`, `session-cookie`.

## Task 4 — `TokenKeys`: signing key, JWKS, local key set

**Files:** `src/auth/token-keys.ts`, `src/auth/token-keys.spec.ts`.

```ts
export interface TokenKeys {
  issuer: string;                 // AUTH_ISSUER
  kid: string;                    // from AUTH_SIGNING_JWK
  privateKey: CryptoKey;          // ES256 signer
  jwks: { keys: JWK[] };          // public signing key + AUTH_PUBLISHED_JWKS
  keySet: JWTVerifyGetKey;        // createLocalJWKSet(jwks)
}
export async function loadTokenKeys(env: { issuer?: string; signingJwk?: string; publishedJwks?: string }): Promise<TokenKeys>;
export async function generateSigningJwk(kid: string): Promise<{ privateJwk: JWK; publicJwk: JWK }>;
export const TOKEN_KEYS = Symbol('TOKEN_KEYS');
export const tokenKeysProvider: FactoryProvider<Promise<TokenKeys>>; // from ConfigService
```

Tests first:
- [x] valid key loads; JWKS entry has `kid`, `alg: 'ES256'`, `use: 'sig'`,
  `kty/crv/x/y` and **no** `d`.
- [x] boot failures: missing issuer, issuer not a URL, missing/invalid JSON,
  RSA or P-384 key, public key (no `d`), empty `kid`, `alg` other than ES256,
  `AUTH_PUBLISHED_JWKS` entry with `d`, duplicate `kid`.
- [x] published keys appear in `jwks.keys` after the signing key.

## Task 5 — `session-token.ts` on ES256 with portal audience

**Files:** `src/auth/session-token.ts`, `src/auth/session-token.spec.ts` (ported).

```ts
export type Portal = 'billing' | 'studio';           // re-exported from src/portal/portal.ts
export interface SessionClaims { id: string; email: string; sid: string }
export function signAccessToken(c: SessionClaims, portal: Portal, keys: TokenKeys): Promise<string>;
export function signRefreshToken(c: SessionClaims, keys: TokenKeys): Promise<string>;
export function verifyToken(t: string, keys: TokenKeys, expected: 'access', audience: Portal): Promise<SessionClaims | null>;
export function verifyToken(t: string, keys: TokenKeys, expected: 'refresh'): Promise<SessionClaims | null>;
```

- [x] Port every existing case (tamper, rewritten claims, expired, alg:none,
  foreign issuer/audience, no subject, garbage, typ separation, lifetimes) to
  ES256 keys; "signed with another secret" becomes "signed with another key".
- [x] New: header carries `kid`; access `aud` is the portal; refresh `aud` is the
  issuer; a billing token fails `verifyToken(…, 'access', 'studio')`; an HS256
  token is rejected; missing `sid` is rejected; payload keys are exactly
  `aud, email, exp, iat, iss, sid, sub, typ`.

## Task 6 — Portal from Origin

**Files:** `src/portal/portal.ts` (types, `parsePortalOrigins`),
`src/portal/portal-origins.ts` (injectable built from `AUTH_PORTAL_ORIGINS`),
`src/portal/portal.guard.ts`, `src/portal/no-portal.decorator.ts`,
`src/portal/current-portal.decorator.ts`, `src/common/cors.ts` (allowlist from
the map; methods `GET, POST, OPTIONS`), specs for each.

- [x] `parsePortalOrigins`: valid list; several origins → one portal; rejects
  empty, missing `=`, unknown portal, path, trailing slash, query, duplicate,
  non-http(s) scheme. Normalises host case.
- [x] `PortalGuard`: sets `request.portal` for a mapped origin; 403
  `Origin not allowed` for missing, unknown, `null` origin; lets `@NoPortal()`
  through without an origin.
- [x] `corsOptions`: origin list equals the map's keys; credentials; methods and
  headers pinned; max-age cases ported.

## Task 7 — Login log service and retention

**Files:** `src/events/auth-event.ts` (kinds, methods, `AuthEventInput`,
`RequestMeta`), `src/events/auth-event.service.ts`,
`src/events/auth-event-retention.ts`, `src/events/events.module.ts`, specs.

```ts
export interface RequestMeta { portal: Portal; ip: string | null; userAgent: string | null }
class AuthEventService {
  record(events: AuthEventInput[]): Promise<void>; // createMany skipDuplicates, never throws
}
export function pruneAuthEvents(prisma, olderThan: Date, batchSize = 5000): Promise<number>;
class AuthEventRetention implements OnApplicationBootstrap, OnModuleDestroy {} // boot + 24 h, unref'd
```

- [x] `record` maps to `createMany({ data, skipDuplicates: true })`, truncates
  user agent to 512, drops an IP `net.isIP` rejects, and swallows + logs a
  failing insert.
- [x] `pruneAuthEvents` loops until a batch deletes 0 and returns the total;
  uses `auth.auth_event`; retention days validated (positive integer, default 365).

## Task 8 — `AuthService` and `AuthController`

**Files:** `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`, ported specs
`auth.service.spec.ts`, `auth-key.service.spec.ts`, `auth-key.controller.spec.ts`,
new `auth-events.spec.ts`.

- [x] Ported specs pass with only fixture changes (ES256 keys, a `RequestMeta`,
  a recording `AuthEventService`).
- [x] Login success: new uuid `sid`; one `record` call with `login_success`
  (method) + `portal_entry`; response `user` has no `sid`.
- [x] Login failure: unknown email and wrong password both write
  `login_failed` (account id null / set), then throw the same 401; a throwing
  recorder does not change the 401; no event carries the typed email.
- [x] PIN: wrong key → `key_failed`; the locking failure → `key_locked`; a
  refusal while locked writes nothing; success → `login_success` method `pin`.
- [x] Refresh: `portal_entry` for `(sid, request portal)`; access token `aud` is
  the request portal; refresh failure writes nothing.
- [x] Logout: valid cookie → `logout` with sub and sid; no/invalid cookie → 204,
  nothing written.

## Task 9 — `JwtAuthGuard` and `/me`

**Files:** `src/auth/jwt-auth.guard.ts`, ported `jwt-auth.guard.spec.ts`.

- [x] Verifies with the local key set and `aud = request.portal`; `DISABLE_AUTH`
  removed; all ported rejection cases pass; a studio token from a billing
  request is 401; `request.user` is `{ id, email }`.

## Task 10 — JWKS endpoint, app wiring, endpoint suites

**Files:** `src/auth/jwks.controller.ts`, `src/auth/auth.module.ts`,
`src/app.module.ts`, `src/app-setup.ts`, `src/main.ts`, `test/create-test-app.ts`,
`test/test-keys.ts`, ported `auth.e2e-spec.ts`, `auth-throttle.e2e-spec.ts`,
`json-content-type.e2e-spec.ts`; new `jwks.e2e-spec.ts`, `portal.e2e-spec.ts`,
`audience.e2e-spec.ts`, `contract.e2e-spec.ts`, `auth-events.e2e-spec.ts`.

- [x] Ported suites pass with an `Origin` on every request.
- [x] JWKS: 200 without origin, `Cache-Control: public, max-age=300`, no `d`,
  includes published keys; a login token verifies against the served JWKS.
- [x] Portal: login from each origin → matching `aud`; missing/unknown origin →
  403 and the account lookup is never called; `portal` in body → 400; CORS
  preflight reflects allowlisted origins only.
- [x] Audience: studio token → 401 at `/me` from billing; the spec §8 verifier
  rejects it for billing and a refresh token for both.
- [x] SSO: login from billing, refresh from studio with the same cookie → studio
  token with the same `sid`.
- [x] Contract: the spec §8 snippet, run against a `createLocalJWKSet` of the
  served JWKS, accepts a billing token for billing and returns `sub/email/sid`.

## Task 11 — Admin scripts

**Files:** `src/scripts.module.ts`, `scripts/{seed-admin,user-add,user-list,set-key}.ts`
(boot `ScriptsModule`), `scripts/generate-signing-key.ts`, `scripts/prune-events.ts`.

- [x] `tsc --noEmit -p tsconfig.json` passes over `scripts/`.
- [x] `signing-key:generate` prints a private JWK that `loadTokenKeys` accepts.

## Task 12 — DB suite

**Files:** `vitest.db.config.mts`, `test/db/setup.ts` (creates a throwaway
database from `TEST_DATABASE_URL`, applies both migrations, drops it after),
`test/db/auth-event.int-spec.ts`.

- [x] Repeated `portal_entry` for one `(sid, portal)` leaves one row; a second
  portal adds one; other kinds are unaffected.
- [x] CHECKs refuse an unknown kind, method and portal.
- [x] `pruneAuthEvents` deletes only rows past the cutoff, across batches.

## Task 13 — Docs and Prisma-level verification

**Files:** `docs/runbooks/auth-table-handover.md`, `README.md`, `.env.example`,
spec amendments (rehearsal results; `BIGSERIAL` rather than identity).

- [x] Runbook: snapshot, precheck, move, `migrate resolve --applied 0_init`,
  `migrate deploy`, verify, drift check, smoke, rollback — each with the exact
  command, using the SQL files from Task 2.
- [x] With a real Prisma engine: spec items 11.2.1–11.2.4, and 11.2.5 over the
  direct connection — **done locally 2026-10-03** (runbook, Rehearsal record).
- [ ] 11.2.5 through PgBouncer in transaction mode (Neon pooler) and 11.2.6
  (billing's drift check, with billing's migration).

## Task 14 — Verify, sync, commit

- [x] `npm test`, `npx tsc --noEmit`, `npm run build` green.
- [x] Copy source (not `node_modules`, `dist`) into the repo on the Mac; branch
  `feat/standalone-auth-service`; commit without trailer.
