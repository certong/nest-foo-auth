# Runbook: handing `account` and `account_pin` from billing to nest-foo-auth

Moves billing's two login tables from schema `public` into schema `auth` of
`foo_platform_db`, without copying a row, and gives them to this repo's
migration history. Spec: `docs/superpowers/specs/2026-10-03-nest-foo-auth-design.md`,
section 11.

| Environment | How the move runs | Who runs it |
|---|---|---|
| local, dev | `scripts/handover/rehearse.sh` (this runbook) | you |
| UAT, production | a hand-written nest-foo-billing migration containing `10-move.sql`, then steps 3–5 here | **not without Chi's go-ahead** |

## Files

| File | What it does | Writes? |
|---|---|---|
| `scripts/handover/00-precheck.sql` | confirms the starting state, prints counts and a digest of `account` | no |
| `scripts/handover/10-move.sql` | `CREATE SCHEMA auth; ALTER TABLE … SET SCHEMA auth` ×2, one transaction, `lock_timeout 5s` | yes |
| `scripts/handover/30-verify.sql` | confirms the end state, re-prints the same counts and digest, probes that the CHECKs and the partial unique index still refuse bad rows (inside a rolled-back transaction) | no |
| `scripts/handover/90-rollback.sql` | puts the tables back in `public`, drops `auth_event` and `auth._prisma_migrations` | yes |
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

Applies `20261003120000_add_auth_event` and nothing else.

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

### Rollback — only while billing still expects its tables in `public`

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

**Not yet run** (needs a real Prisma engine; `binaries.prisma.sh` is blocked in
the cloud workspace): steps 3, 4 and 6 with Prisma itself — that `resolve`
writes `auth._prisma_migrations`, that `deploy` applies `add_auth_event`, that
the drift check is clean and does not try to drop the partial index — and the
service running through Neon's pooler. Steps 3–4 were simulated with `psql`.
Run `scripts/handover/rehearse.sh` against local to close these.
