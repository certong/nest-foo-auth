# nest-foo-auth: spec vs code (2026-10-06)

What the two specs ask for, set against what the code and its tests show.
Evidence is code and spec files, never plan checkboxes.

- **Branch read:** `feat/standalone-auth-service` at `1c56411` (5 commits, pushed to `origin` on 2026-10-06; no `main` yet; not deployed anywhere).
- **Test run:** `npm test` on 2026-10-06, Node 24.20.0: **28 files, 327 tests, all passing.**
- **Not run:** the opt-in database suite (`npm run test:db`, `test/db/auth-event.int-spec.ts`). It needs `TEST_DATABASE_URL` and creates a throwaway database. Its last recorded pass is 2026-10-03 in the runbook (16 tests). Rows that lean on it say so.
- **Billing side:** read from `nest-foo-billing`, branch `feat/auth-service-handover` (5 commits, pushed 2026-10-06, **not merged**). I read that code but did not run its tests.

**Status words**

| Status | Meaning |
|---|---|
| Built | code plus a passing spec file |
| Partly | code exists but a piece has no spec, or a piece is missing; the Notes say which |
| Not built | nothing in the repo |
| Decided-not-to | the spec rules it out, or defers it on purpose |
| n/a | background only |

Short names: **main spec** = `docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md`,
**AT spec** = `docs/superpowers/specs/2026-10-03-account-types-design.md`,
**runbook** = `docs/runbooks/auth-table-handover.md`.

## Counts

| Group | Built | Partly | Not built | Decided-not-to | n/a |
|---|---|---|---|---|---|
| Main spec §1–12, §14, §17 | 28 | 4 | 1 | 2 | 2 |
| Main spec §15 (decisions made) | 15 | 1 | 0 | 0 | 0 |
| Main spec §16 + other open decisions | 6 answered | 0 | 3 open | 1 deferred | 0 |
| AT spec §1–10 | 9 | 1 | 0 | 1 | 2 |
| Not in the spec (deploy, CI, dual-accept, cut-over) | 0 | 0 | 4 | 0 | 0 |
| **FA total** | **52** (+6 decisions answered) | **6** | **8** | **4** | **4** |
| Main spec §13 (billing, CP) | 0 | 7 | 0 | 0 | 0 |

## 1. Main spec, sections 1–12, 14 and 17

| Spec § | Requirement (one line) | Status | Evidence (file + spec file) | Notes |
|---|---|---|---|---|
| 1 | Goal: one sign-in for every portal, one issuer, every login logged | n/a | — | Delivered by the rows below. |
| 2 | Topology: `auth.<domain>` between two SPAs and two verify-only backends, all on one registrable domain | Partly | `src/app-setup.ts`, `src/portal/portal.ts`; `test/portal.e2e-spec.ts` | The service is built. No hostnames or domain are chosen, nothing is deployed, and the studio backend does not exist. |
| 3 | Port billing's auth files and stack unchanged, apart from the listed changes | Built | every file in the §3 table exists under `src/` and `test/`; ported specs pass (`password`, `key-lockout`, `account-pin`, `user-admin`, `session-cookie`, `harness`) | `key-throttler.filter.ts` has no spec file of its own; it is tested in `auth-key.controller.spec.ts`. **Gap:** the spec says Node 24 (`.nvmrc` agrees) but the `Dockerfile` builds on `node:20-slim`. |
| 4 | `AUTH_PORTAL_ORIGINS` parsed and validated at boot | Built | `src/portal/portal.ts`, `portal-origins.ts`; `portal.spec.ts` | |
| 4 | `PortalGuard`: portal from `Origin`, 403 `Origin not allowed` before any credential is read | Built | `src/portal/portal.guard.ts`; `portal.guard.spec.ts`, `test/portal.e2e-spec.ts` | |
| 4 | `@NoPortal()` only on JWKS and health; portal never read from body or query | Built | `no-portal.decorator.ts`, `jwks.controller.ts`, `health.controller.ts`; `test/portal.e2e-spec.ts` | |
| 4 | CORS reflects only allowlisted origins, credentials on, methods and headers pinned | Built | `src/common/cors.ts`; `cors.spec.ts`, `test/portal.e2e-spec.ts` | |
| 5 | ES256 only, P-256 key, `kid` in every header, pinned on verify | Built | `src/auth/token-keys.ts`, `session-token.ts`; `token-keys.spec.ts`, `session-token.spec.ts` | HS256 and `alg:none` rejections are tested. |
| 5 | Lifetimes: access 15 min, refresh 12 h | Built | `session-token.ts`; `session-token.spec.ts` ("token lifetimes"), `session-cookie.spec.ts` | |
| 5.1 | Claims: `iss`, `aud` (portal for access, issuer for refresh), `sub`, `email`, `sid`, `typ` | Built | `session-token.ts`; `session-token.spec.ts` ("audiences", "token types are not interchangeable") | The AT spec later added `account_type` and `client_id`. |
| 5.2 | Login mints `sid`, sets the cookie, returns a portal access token; refresh re-mints for the request's portal | Built | `auth.service.ts`, `auth.controller.ts`; `auth.service.spec.ts`, `test/contract.e2e-spec.ts` ("single sign-on") | **Differs from the text:** §5.2 says "no DB read for claims". Refresh now reads the account by primary key, as AT spec §7.2 decided. |
| 5.3 | Key config (`AUTH_SIGNING_JWK`, `AUTH_PUBLISHED_JWKS`), boot checks, rotation by publishing two keys | Built | `token-keys.ts`, `scripts/generate-signing-key.ts`; `token-keys.spec.ts`, `test/jwks.e2e-spec.ts`; steps in `README.md` | `generate-signing-key.ts` has no spec. Rotation has never been done on a running service. |
| 6 | `POST /api/auth/login`, `/key`, `/refresh`, `/logout`, with the stated shapes, throttle and status codes | Built | `auth.controller.ts`; `test/auth.e2e-spec.ts`, `auth-key.controller.spec.ts`, `test/auth-throttle.e2e-spec.ts` | |
| 6 | `GET /.well-known/jwks.json`: public, no origin, `Cache-Control: public, max-age=300` | Built | `jwks.controller.ts`; `test/jwks.e2e-spec.ts` | |
| 6 | `GET /api/health` returns `{ status: 'ok' }` with no origin | Built | `health.controller.ts`; `test/portal.e2e-spec.ts` ("leaves the health check reachable with no Origin") | No spec file of its own. |
| 6.1 | `GET /api/me` needs a bearer token whose `aud` is the request's portal | Built | `jwt-auth.guard.ts`; `jwt-auth.guard.spec.ts`, `test/contract.e2e-spec.ts` | |
| 6.2 | Logout clears the one cookie, always 204, logs only with a valid cookie | Built | `auth.service.ts`, `auth.controller.ts`; `auth-events.spec.ts` ("logout"), `test/auth.e2e-spec.ts` | |
| 6.3 | Refresh cookie: host-only, `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`, 12 h, named `cp_refresh` | Built | `session-cookie.ts`; `session-cookie.spec.ts` | |
| 7.1 | Table `auth.auth_event` with CHECKs and the partial unique index | Built | `prisma/migrations/20261003120000_add_auth_event`, `prisma/schema.prisma`; `test/db/auth-event.int-spec.ts` | Proof is in the opt-in DB suite, not run today. |
| 7.2 | Each event kind is written at the right moment; `portal_entry` once per `(sid, portal)` | Built | `auth.service.ts`, `src/events/auth-event.service.ts`; `auth-events.spec.ts`, `test/auth-events.e2e-spec.ts` | |
| 7.3 | Writing the log never changes a failed login, and never blocks a good one | Built | `auth.service.ts` (`log`), `auth-event.service.ts`; `auth-events.spec.ts`, `auth-event.service.spec.ts` | |
| 7.4 | Example queries | n/a | — | Documentation only. |
| 7.5 | Retention: prune rows older than 365 days, in batches, at boot and every 24 h; `npm run events:prune` | Built | `src/events/auth-event-retention.ts`, `scripts/prune-events.ts`; `auth-event-retention.spec.ts` | The script wrapper has no spec. The SQL itself is proven only in the DB suite. |
| 8 | The verifier contract is tested here against real issued tokens | Built | `test/contract.e2e-spec.ts` | |
| 8 | A verify-only guard exists in each product backend | Decided-not-to | — | Not this repo's work (§14). Billing's guard is the CP row for §13.2. The studio backend does not exist yet. |
| 9.1 | Schema `auth` with its own migration history via `?schema=auth` | Built | `prisma/schema.prisma`; runbook, "With Prisma, local" | Proven by the local rehearsal, not by a spec file. |
| 9.2 | Models `Account`, `AccountPin`, `AuthEvent` | Built | `prisma/schema.prisma`; `test/db/auth-event.int-spec.ts` | |
| 9.3 | Migrations `0_init` (with its "came from billing" guard) and `add_auth_event` | Built | `prisma/migrations/0_init`, `20261003120000_add_auth_event`; runbook rehearsal record | |
| 10 | Every setting is validated at boot | Partly | `token-keys.ts`, `portal.ts`, `session-cookie.ts`, `auth-event-retention.ts`, `.env.example`; their specs | `TRUST_PROXY` (`app-setup.ts`) and the `PORT` default (`main.ts`) have no test. |
| 11.1 | Move the tables with `ALTER TABLE … SET SCHEMA auth`, no rows copied | Built | `scripts/handover/10-move.sql`; runbook rehearsal record | The deployed version of this SQL is billing's migration (CP, §13.1). |
| 11.2 | Six checks before relying on the move | Partly | runbook, "Rehearsal record" | Items 1–4 and 6 pass locally. **Item 5 is proven on the direct URL only, not through Neon's pooler.** |
| 11.3 | Runbook: snapshot, precheck, move, baseline, forward, verify, smoke, rollback | Built | runbook; `scripts/handover/00-precheck.sql`, `10-move.sql`, `30-verify.sql`, `90-rollback.sql`, `rehearse.sh` | Rehearsed on local Postgres 18.6 on 2026-10-03. |
| 11.4 | Cut-over on UAT and production, in the stated order | Not built | — | Never run. Needs a deployed auth service first. |
| 12 | Test-first, database-free default suite, plus the listed new suites | Built | 28 spec files, 327 tests passing | The plan names `test/audience.e2e-spec.ts`, which does not exist; those cases are in `test/contract.e2e-spec.ts`. |
| 14 | Out of scope: sign-up, password reset, roles, session table, revocation, shared guard package | Decided-not-to | — | "No roles" was partly reopened by the AT spec (staff and client). |
| 17.1–17.5 | Amendments: `BIGSERIAL` id, double-guarded log calls, one `configureApp()`, explicit guard order, first sweep after one minute | Built | `app-setup.ts`, `app.module.ts`, `auth.service.ts`, `auth-event-retention.ts`; `auth-events.spec.ts`, `auth-event-retention.spec.ts` | |
| 17.6 | Rehearsal results recorded; the remaining items closed on a machine with a Prisma engine | Partly | runbook | All closed locally except the pooler check (same gap as §11.2 item 5). |

## 2. Main spec, section 15: decisions already made

All were approved with the spec. This checks that the code follows each one.

| Spec § | Decision | Status | Evidence | Notes |
|---|---|---|---|---|
| 15.1 | Unknown or missing origin is 403, not 401 | Built | `portal.guard.ts`; `portal.guard.spec.ts` | |
| 15.2 | Refresh token `aud` is the issuer | Built | `session-token.ts`; `session-token.spec.ts` | |
| 15.3 | Signing key is a one-line private JWK | Built | `token-keys.ts`; `token-keys.spec.ts` | |
| 15.4 | `VARCHAR` + `CHECK`, not Postgres enums | Built | migration SQL; `test/db/auth-event.int-spec.ts` | DB suite. |
| 15.5 | `auth_event.account_id` has no foreign key | Built | `prisma/schema.prisma`, migration SQL | Structural; nothing to test. |
| 15.6 | Login also writes `portal_entry` | Built | `auth.service.ts`; `auth-events.spec.ts` | |
| 15.7 | Locked refusals, 429s, 403s, 400s and failed refreshes are not logged | Built | `auth.service.ts`; `auth-events.spec.ts` | |
| 15.8 | Log writes are awaited but never fatal | Built | `auth-event.service.ts`; `auth-event.service.spec.ts` | |
| 15.9 | Admin scripts boot a small `ScriptsModule` | Partly | `src/scripts.module.ts`, `scripts/*.ts` | No spec. The plan checked it with `tsc` only. |
| 15.10 | Cookie name stays `cp_refresh` | Built | `session-cookie.ts`; `session-cookie.spec.ts` | |
| 15.11 | The move SQL ships as a billing migration | Built | billing: `prisma/migrations/20261003150000_move_account_tables_to_auth` | Exists only on billing's unmerged branch. See §13.1. |
| 15.12 | `DISABLE_AUTH` is dropped here | Built | `jwt-auth.guard.ts` has no bypass; `jwt-auth.guard.spec.ts` | |
| 15.13 | `timestamptz` for `auth_event.created_at` | Built | `prisma/schema.prisma` | |
| 15.14 | Retention runs in-process | Built | `auth-event-retention.ts`; its spec | |
| 15.15 | Opt-in DB suite | Built | `vitest.db.config.mts`, `test/db/` | |
| 15.16 | Port 3001 by default | Built | `main.ts`, `Dockerfile` | No test. |

## 3. Open decisions and questions

Section 16 of the main spec, plus the candidates named in the handoff.

| Source | Question | Status | Does the code answer it? | Notes |
|---|---|---|---|---|
| Main §16 | Role separation: a dedicated Postgres role for schema `auth` | Not built (open) | No | "Billing never reads `auth.*`" is a convention today. The spec says it is worth doing before studio exists. |
| Main §16 | Rehearse on a new Neon branch from dev | Not built (open) | No | This is what would prove the pooler check (§11.2 item 5). |
| Main §16 | Commit convention | Answered | Yes | The plan says: branch `feat/standalone-auth-service`, no `Co-Authored-By` trailer. All 5 commits follow it. |
| Main §16 | Throttle storage when more than one instance runs | Decided-not-to (deferred) | In-memory, per instance | The spec says fine for now, Redis if it scales out. Becomes a constraint on the deploy: one instance. |
| Handoff | A per-app `aud` claim | Answered | Yes: `billing` and `studio` | `session-token.ts`; `session-token.spec.ts`. **The values are not `foo-billing` / `foo-studio`.** |
| Handoff | Cookie domain, SameSite and CORS across subdomains | Answered | Yes: host-only cookie, `SameSite=Lax`, CORS with credentials from the portal map | `session-cookie.ts`, `cors.ts`. It works only if every host shares one registrable domain (§2). Not yet tried in a real browser on deployed subdomains. |
| Handoff | Where `GET /me` lives | Answered | Both | Auth has `/api/me` (main §6.1). Billing keeps its own `/api/me` as the frontend's boot probe (`me.controller.ts` on billing's branch). |
| Handoff | Does foo-studio have users other than the admin? | Answered | Yes: client logins | AT spec §1 and §3. |
| Handoff | JWKS key rotation (`kid`) | Answered | Yes | Main §5.3; `token-keys.spec.ts` ("verifies a token signed by a published rotation key"). Never drilled on a running service. |
| Billing plan, "Open" | Which hostnames and domain auth is deployed on | Not built (open) | No | Blocks the deploy, `AUTH_ISSUER`, `AUTH_PORTAL_ORIGINS`, billing's `AUTH_JWKS_URL` and the frontend's `VITE_AUTH_URL`. |

## 4. Account-types spec

| Spec § | Requirement (one line) | Status | Evidence (file + spec file) | Notes |
|---|---|---|---|---|
| AT 1 | The requirement: billing is staff-only, studio has staff and clients | n/a | — | |
| AT 2 | Columns `account_type`, `client_id`, `disabled_at`, two CHECKs, an index | Built | `prisma/migrations/20261003140000_account_types`, `prisma/schema.prisma`; `test/db/auth-event.int-spec.ts` ("account types") | CHECK proof is in the DB suite. |
| AT 3 | Portal access table, checked at login, PIN login and refresh; 403 plus a `portal_denied` row | Built | `src/auth/account-type.ts`, `auth.service.ts`; `account-type.spec.ts`, `auth-events.spec.ts`, `test/account-types.e2e-spec.ts` | |
| AT 4 | Claims `account_type` and `client_id`; `/me` and login gain `accountType` and `clientId` | Built | `session-token.ts`, `authenticated-user.ts`; `session-token.spec.ts` ("account type claims"), `test/account-types.e2e-spec.ts` ("/me") | |
| AT 5 | Contract: verifiers read `account_type`; billing accepts staff only; studio filters by `client_id` | Built | `test/contract.e2e-spec.ts` | Tested here. Billing's check is CP work (§13.2). Studio's filter belongs to studio's own design. |
| AT 6 | Scripts: `user:add` types, `user:list` columns, `seed:admin` and `key:set` refuse clients | Partly | `src/auth/user-admin.ts`, `account-pin.ts`, `scripts/*.ts`; `user-admin.spec.ts`, `account-pin.spec.ts` | `seed:admin`'s refusal of a client account (`scripts/seed-admin.ts`) has no spec. The script wrappers have none either. |
| AT 7.1 | Name `account_type`, values `staff` / `client` | Built | `account-type.ts`; `account-type.spec.ts` | |
| AT 7.2 | Disabling a login: `disabled_at`, `user:disable` / `user:enable`, refused at login and refresh | Built | `user-admin.ts` (`setDisabled`), `auth.service.ts`; `user-admin.spec.ts`, `test/account-types.e2e-spec.ts` ("disabled logins") | |
| AT 7.3–7.4 | 403 for a portal denial; new log kind `portal_denied` | Built | `account-type.ts`, `src/events/auth-event.ts`; `auth-events.spec.ts` | |
| AT 7.5 | Client accounts cannot hold the PIN | Built | `account-pin.ts`; `account-pin.spec.ts` | |
| AT 8 | Not in this change: creating client logins from a screen, roles within staff | Decided-not-to | — | |
| AT 9 | One migration; everyone signs in once more after deploy | Built | migration `20261003140000_account_types`; runbook | Applied locally only. |
| AT 10 | As-built record | n/a | — | Matches the code I read. |

## 5. Not in the spec (added on request)

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Deploy nest-foo-auth: host, environment variables, the `auth.<domain>` address | Not built | `Dockerfile`, `.env.example` | The Dockerfile's comments assume Railway. No host, domain or environment exists. The Dockerfile is on Node 20, not 24. |
| CI for nest-foo-auth | Not built | no `.github/` directory | Tests run only on a laptop. The repo has no `main` branch. |
| Dual-accept window: billing accepts old and new tokens until the switch is proven | Not built | — | **The spec decides the opposite.** Main §11.4 accepts a hard cut ("a window of minutes… everyone signs in again"), and billing's handover branch deletes the HS256 path outright. |
| Production cut-over following the runbook | Not built | runbook; main §11.4 | Rehearsed locally only. UAT has not been cut over either. |

## 6. Main spec section 13: billing-side work (CP, not FA)

All of this exists on `nest-foo-billing` branch `feat/auth-service-handover`
(`00af2b3` … `43f7a14`). That branch was pushed on 2026-10-06 and is **not merged**
into `development`. I read the code; I did not run billing's tests. Billing's
own plan records 586 passing on 2026-10-03.

| Spec § | Requirement (one line) | Status | Evidence on billing's branch | What is missing |
|---|---|---|---|---|
| 13.1 | Hand-written migration moving `account` and `account_pin` to `auth`, with a guard; both models dropped in the same change | Partly | `prisma/migrations/20261003150000_move_account_tables_to_auth/migration.sql`; `prisma/schema.prisma` has neither model | Not merged. Never run on UAT or production. |
| 13.2 | Verify-only guard: ES256, JWKS, `aud = 'billing'`, staff only; `/me` from the token | Partly | `src/auth/jwt-auth.guard.ts`, `jwks.provider.ts`, `me.controller.ts`; `jwt-auth.guard.spec.ts`, `test/me.e2e-spec.ts` | Not merged. |
| 13.3 | Remove `AuthController`, `AuthService`, PIN, throttler, cookie and password code, admin scripts | Partly | 3,382 lines deleted against `development` | Not merged. |
| 13.4 | Env: old auth variables out, `AUTH_ISSUER` and `AUTH_JWKS_URL` in | Partly | `.env.example`, `src/auth/jwks.provider.ts` | Deployed env files wait on the auth hostnames. |
| 13.5 | Test helpers sign with a local ES256 key and JWKS | Partly | `test/auth-keys.ts`, `test/create-test-app.ts` | Not merged. |
| 13.6 | Frontend calls `auth.<domain>` for login, key, refresh and logout | Partly | `react-foo-billing`, worktree branch `feat/auth-service-login` (`b3e2f3a`), `VITE_AUTH_URL` | Pushed 2026-10-06, not merged. The live smoke test and browser click-through have not been redone. |
| — | `API.md` regenerated and the "planned, not done" note removed from `INSTRUCTIONS.md` §4 | Partly | both edited on the branch | `INSTRUCTIONS.md` was rewritten on `chore/docs-sync-and-housekeeping` (`260726c`) after the branch was cut, so the two will conflict. |

## 7. Gaps found (not fixed; they become tickets)

1. The pooled connection (Neon pooler, PgBouncer in transaction mode) is unproven: main §11.2 item 5.
2. `Dockerfile` builds on `node:20-slim`; the spec and `.nvmrc` say Node 24.
3. `TRUST_PROXY` handling in `app-setup.ts` has no test.
4. No spec for the script wrappers, `ScriptsModule`, or `seed:admin`'s refusal of a client account.
5. No CI, no `main` branch, nothing deployed.
6. The plan names three files that do not exist: `src/portal/current-portal.decorator.ts`, `test/audience.e2e-spec.ts`, `test/db/setup.ts` (the real one is `test/db/throwaway-database.ts`). Nothing is missing in behaviour.
7. Billing's handover branch and the frontend's login branch were local only until they were pushed on 2026-10-06. Neither is merged.

### Closed since this reading

The rows and gaps above are the 2026-10-06 reading and are left as they were. What has changed since:

`npm test` on 2026-10-07, Node 24.20.0: **31 files, 344 tests, all passing** (was 28 and 327).

- **Gap 3, 4 and 6 — closed by FA-19 on 2026-10-07.** `TRUST_PROXY` now has `test/trust-proxy.e2e-spec.ts` (the hop count, and that an unset variable leaves Express alone), asserted on the `auth_event` row. `seed:admin`'s logic moved to `seedAdmin` in `src/auth/user-admin.ts` and its refusal of a client account is covered in `user-admin.spec.ts`; the script is now the same thin wrapper as its six siblings. `ScriptsModule` has `src/scripts.module.spec.ts`, which also pins what it leaves out — no signing key, no portal map, no retention sweep. `signing-key:generate` has `test/signing-key-generate.spec.ts`, which runs the real script and feeds what it prints back to `loadTokenKeys`. The three wrong file names are corrected in the plan.
  - Still open from gap 4: the other five script wrappers have no spec of their own. Their argument and environment handling is a few lines each over functions that are tested; FA-19 put them out of scope.
  - Still open from row 10: the `PORT` default in `main.ts`. It is unreachable from a test without splitting `bootstrap()` out of the entry point, which FA-19's "change no behaviour" rules out.
- **Gap 2 — closed on 2026-10-07** (`d9afb53`): the `Dockerfile` builds on Node 24.
- **The commit convention changed on 2026-10-07.** Row "Main §16 — Commit convention" above reads "no `Co-Authored-By` trailer. All 5 commits follow it", which was true of the five commits on the branch at the time of this reading. The rule has since been amended in the plan: work authored with Claude carries the trailer, and changes land on `development` by pull request rather than on a single long-lived branch. The five original commits are unchanged.
- **Gap 5, all but deployment — closed on 2026-10-07** (`8453e72` and FA-18). `development`, `uat` and `main` exist and are pushed; `development` is the default branch; all three are protected by one ruleset requiring a pull request and a green CI run. `.github/workflows/ci.yml` has now actually run — 31 files, 344 tests, the database suite against Postgres 18 and the image build, all green — which it never had before: GitHub Actions was switched off at the repository level, not merely unconfigured. The branch names are recorded in `README.md` ("Branches and CI"). Nothing is deployed yet (FA-12).

## 8. Tickets

FA-1 (epic), FA-2 to FA-11 (built, Done), FA-12 to FA-21 (open). Billing side: CP-77 (epic), CP-78 to CP-84.
