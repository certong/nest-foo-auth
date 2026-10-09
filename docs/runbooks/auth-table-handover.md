# Runbook: handing `account` and `account_pin` from billing to nest-foo-auth

Moves billing's two login tables from schema `billing` into schema `auth` of
`foo_platform_db`, without copying a row, and gives them to this repo's
migration history. Spec: `docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md`,
section 11.

| Environment | How the move runs | Who runs it |
|---|---|---|
| local, dev | `scripts/handover/rehearse.sh` (this runbook) | you |
| UAT, production | nest-foo-billing's migration `20261003150000_move_account_tables_to_auth` (`10-move.sql` plus a guard), shipped with billing's release, then steps 3–5 here | **not without Chi's go-ahead** |

Where `rehearse.sh` already moved the tables (local, and Neon dev if it was
rehearsed there), billing's migration must be marked applied, not run:
`npx prisma migrate resolve --applied 20261003150000_move_account_tables_to_auth`
in nest-foo-billing. Its guard refuses to run on an already-moved database. If
`deploy` was run anyway, mark the failed row `--rolled-back` first.

Billing's schema was `public` until 2026-10-07, and the scripts here named it.
They now name `billing`. A database built before that date still has billing's
tables in `public` and is renamed first (nest-foo-billing README, "Billing's
schema"); until then the precheck prints `f` and `0_init` refuses it by name.
The rehearsal record below predates the rename, so it says `public`.

## Files

| File | What it does | Writes? |
|---|---|---|
| `scripts/handover/00-precheck.sql` | confirms the starting state, prints counts and a digest of `account` | no |
| `scripts/handover/10-move.sql` | `CREATE SCHEMA auth; ALTER TABLE … SET SCHEMA auth` ×2, one transaction, `lock_timeout 5s` | yes |
| `scripts/handover/30-verify.sql` | confirms the end state, re-prints the same counts and digest, probes that the CHECKs and the partial unique index still refuse bad rows (inside a rolled-back transaction) | no |
| `scripts/handover/90-rollback.sql` | puts the tables back in `billing`, drops `auth_event` and `auth._prisma_migrations` | yes |
| `scripts/handover/rehearse.sh` | runs 00 → 10 → resolve → deploy → 30 → drift, against the active `.env`; refuses unless `APP_ENV` is `local` or `dev` | yes |

`psql` does not accept Prisma's `schema=auth` URL parameter. `rehearse.sh`
strips it into `$PSQL_URL`; by hand, drop `schema=auth` from the URL and keep
the rest.

## Steps

### 0. Snapshot

- **Local:** `pg_dump -Fc -h localhost -U foo -d foo_platform_db -f foo_platform_db-$(date +%Y%m%d-%H%M).dump`
- **Neon:** create a branch from the target in the Neon console and rehearse on
  the branch first. Point a new `.env.<name>` at the branch with `APP_ENV=dev`.

### 1. Precheck — read-only

```bash
psql "$PSQL_URL" -X -f scripts/handover/00-precheck.sql
```

Every `ok` must be `t`. Write down `accounts`, `pin_holder`, `pin_set`,
`account_digest`.

### 2. Move — over the **direct** URL

```bash
psql "$PSQL_URL" -X -f scripts/handover/10-move.sql
```

Takes an `ACCESS EXCLUSIVE` lock on both tables for milliseconds. If it waits
more than five seconds (a long transaction holds a lock), it aborts and
nothing has changed; retry.

From this moment, any running billing build that still reads `account` fails
its logins. That is the cutover window (spec 11.4).

### 3. Baseline — `0_init` is already true here

```bash
npx prisma migrate resolve --applied 0_init
```

Creates `auth._prisma_migrations` (because the URL says `schema=auth`) and marks
`0_init` applied without running it. If `0_init` ever runs against a database
that came from billing, its first statement stops it with a message saying to
do this instead.

### 4. Forward

```bash
npx prisma migrate deploy
```

Applies `20261003120000_add_auth_event` and `20261003140000_account_types`
(every existing account becomes `staff`; no backfill needed).

### 5. Verify — read-only

```bash
psql "$PSQL_URL" -X -f scripts/handover/30-verify.sql
```

Every `ok` must be `t`, the four figures must equal step 1's, and the last line
must be `NOTICE: rule probes: all refused as expected`.

### 6. Drift

```bash
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script --exit-code
```

No SQL and exit 0 means `schema.prisma` and the database agree. Any output is a
finding — in particular a `DROP INDEX "auth_event_portal_entry_once"` would mean
Prisma does not tolerate the partial index, and the fallback in spec 11.2.3
applies.

Billing side, read-only, from the billing repo with its current code:

```bash
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
```

Expected: only `CREATE TABLE "account"` / `"account_pin"` and their indexes —
the models billing's own change removes. Anything else is unrelated drift in
billing.

### 7. Smoke

```bash
npm run start:dev
```

From a portal origin listed in `AUTH_PORTAL_ORIGINS`: sign in, refresh, refresh
from the other portal's origin, sign out. Then:

```sql
SELECT created_at, kind, method, portal, sid FROM auth.auth_event ORDER BY id DESC LIMIT 10;
```

Expect `login_success`, `portal_entry` (one per portal), `logout`, all with one
`sid`.

### Rollback — only while billing still expects to own the tables

```bash
psql "$PSQL_URL" -X -f scripts/handover/90-rollback.sql
psql "$PSQL_URL" -X -f scripts/handover/00-precheck.sql   # every ok t again
```

`auth_event` rows are lost.

## Rehearsal record

2026-10-03, on copies of `billing/backups/local-postgres-public-before-drop-20261003.sql`
(Postgres 16) and `neon-dev-full-20261003.sql` (Postgres 18) in a throwaway
cloud workspace. Nothing ran against a real database.

| Check | PG16 (local copy) | PG18 (Neon dev copy) |
|---|---|---|
| precheck all `t` | ✅ | ✅ |
| move | ✅ | ✅ |
| row counts and `account` digest equal before and after | ✅ | ✅ |
| both `account_pin` CHECKs, FK, unique and PK kept | ✅ | ✅ |
| PG17+ named NOT NULL constraints kept (`account_id_not_null` …) | n/a | ✅ |
| CHECK, pairing and partial-unique probes all refused | ✅ | ✅ |
| moved tables identical to a fresh `0_init` + `add_auth_event` build (every column, default, constraint and index definition compared from the catalogue) | ✅ | ✅ |
| `0_init` refuses to run on a moved database | — | ✅ |
| rollback restores the precheck state; `public._prisma_migrations` untouched (15 rows) | ✅ | ✅ |
| `ON CONFLICT DO NOTHING` + partial index: repeats in one statement, across statements and 20 concurrent inserts leave one `portal_entry` | — | ✅ |

Steps 3–4 were simulated with `psql` there; the Prisma run below closes them.

### With Prisma, local (2026-10-03)

`scripts/handover/rehearse.sh` against the developer machine's local
`foo_platform_db` (Postgres 18.6 in Docker), Prisma 6.19.3. Snapshot first, with
the container's own `pg_dump` — the Homebrew client is 17 and refuses an 18
server:

    docker exec -e PGPASSWORD=… postgres pg_dump -Fc -h localhost -U foo \
      -d foo_platform_db > ~/foo_platform_db-pre-handover.dump

| Check (spec §11.2) | Result |
|---|---|
| precheck all `t` (1 account, PIN set) | ✅ |
| 1. `migrate resolve --applied 0_init` creates `auth._prisma_migrations`; `public._prisma_migrations` untouched (15 rows, same digest before and after) | ✅ |
| `migrate deploy` applies `add_auth_event` and `account_types` | ✅ |
| verify all `t`, account digest unchanged, "rule probes: all refused as expected" | ✅ |
| 2./3. drift check: empty migration, exit 0 — Prisma does **not** try to drop `auth_event_portal_entry_once`; the §11.2.3 fallback is not needed | ✅ |
| 4. both `account_pin` CHECKs present and refusing | ✅ |
| `npm run test:db` (16 tests) | ✅ |
| 5. service on the **direct** URL: login, refresh from both origins (SSO), `/me`, logout, wrong password 401, no/foreign Origin 403, aud mismatch 401; client account gets 403 at billing (login and refresh) and signs in at studio with `client_id`; `auth_event` rows as specified, one `portal_entry` per (sid, portal) | ✅ |

Smoke-test note: every POST, including `refresh` and `logout` with no body, must
send `Content-Type: application/json` or it gets 415 (the CSRF control). The
portals' fetch calls must set it.

### Billing's migration, local throwaway copies (2026-10-03)

The cutover in production order, on a restored copy of the pre-handover dump:
billing `migrate deploy` (the move), then auth's `resolve --applied 0_init` and
`deploy`, then verify. The digests match, verify shows 11 `t`, the rule probes
are refused, and neither service shows drift. §11.2.6 passes: billing's shadow
replay against its `schema.prisma` gives an empty migration. Also proven: the
guard's message reaches the operator through `prisma migrate deploy`; a failure
half-way leaves both tables in `public`; and with a lock held on `account`, the
migration gives up at the 5 s `lock_timeout`.

**Still open:** §11.2.5 through Neon's **pooler** (Step 3 of the cutover
rehearsal, on a new Neon branch from dev).
