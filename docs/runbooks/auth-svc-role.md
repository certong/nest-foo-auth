# A role of its own for schema `auth` (FA-22)

Before this, every service connects to Postgres as one role, so nothing in the
database stops billing, or a later studio, reading or writing `auth.account`.
That table holds the password hashes and, through `auth.account_pin`, the PIN
hash. This runbook gives schema `auth` to a role only nest-foo-auth uses, and
shuts the shared role out.

Run it per environment, **after** that environment's cut-over. Done afterwards,
the handover runbook and billing's migration need no change (FA-20, FA-22).

| Where | Who |
|---|---|
| a Neon branch made from dev | you, first — see "Before a real environment" |
| development | you |
| UAT, production | **not without Chi's go-ahead** |

Below, "the billing role" is the role every service connects as today. It owns
the tables now, and billing goes on using it afterwards.

## Before a real environment

The local rehearsal (see the record) proves the SQL. It cannot prove Neon, where
two things differ and both are checked by `00-precheck.sql`:

- **The billing role may be able to read everything regardless.** A superuser,
  or a member of `pg_read_all_data`, reads every table whatever a schema's
  privileges say. Neon's default owner role is a member of `neon_superuser`; if
  the precheck prints `f` on `billing role lacks pg_read_all_data`, revoking
  `USAGE` refuses nothing and the negative test in step 5 will pass a `SELECT`
  it should refuse. The fix is then on billing's side: billing needs a plain
  role of its own too, which is a change to this story's scope, not a step here.
- **Creating a role over SQL** rather than in the Neon console. Step 2 does it
  over SQL on purpose: a role made in the console joins `neon_superuser`, which
  is more than a service should hold.

So: create a branch from dev in the Neon console, point a `.env.<name>` at it
with `APP_ENV=dev`, and run steps 1 to 6 there before touching dev itself.

## Files

| File | What it does | Writes? |
|---|---|---|
| `scripts/roles/00-precheck.sql` | confirms the starting state and that the billing role can be shut out at all | no |
| `scripts/roles/10-create-role.sql` | creates the auth role, login-only; leaves an existing one alone | yes |
| `scripts/roles/20-transfer.sql` | gives schema `auth` and its tables to the auth role, revokes everyone else; one transaction, `lock_timeout 5s` | yes |
| `scripts/roles/30-verify.sql` | confirms the end state from the catalogue | no |
| `scripts/roles/90-rollback.sql` | gives everything back to the billing role | yes |

Each takes `-v auth_role=…` (default `auth_svc`) and `-v billing_role=…`
(default: whoever runs it). `$PSQL_URL` is the **direct** URL of the billing
role with `schema=auth` dropped, as in the handover runbook.

## Steps

### 0. Snapshot

Create a Neon branch from the target in the console. It is the way back if the
rollback script is not enough.

### 1. Precheck — read-only

```bash
psql "$PSQL_URL" -X -f scripts/roles/00-precheck.sql
```

Every `ok` must be `t`. Stop on any `f`; the last two are explained above.

### 2. Create the role

Make a password for this environment only, and keep it only in this
environment's secrets:

```bash
AUTH_SVC_PASSWORD=$(openssl rand -hex 24)
psql "$PSQL_URL" -X -v auth_svc_password="$AUTH_SVC_PASSWORD" -f scripts/roles/10-create-role.sql
```

### 3. Transfer — over the **direct** URL

```bash
psql "$PSQL_URL" -X -f scripts/roles/20-transfer.sql
```

The running service is still connected as the billing role and loses access the
moment this commits: **sign-in fails from here until step 6**. Have the new
URLs ready before running it.

### 4. Verify — read-only

```bash
psql "$PSQL_URL" -X -f scripts/roles/30-verify.sql
```

Every `ok` must be `t`.

### 5. Prove it, as each role

As the **billing** role, this must be refused. Record the exact error:

```bash
psql "$PSQL_URL" -X -c 'SELECT * FROM auth.account'
# ERROR:  permission denied for schema auth
```

As the **auth** role, with `DIRECT_URL` and `DATABASE_URL` in the active `.env`
now naming `auth_svc` and its password:

```bash
npx prisma migrate deploy      # "No pending migrations", or applies them
npx prisma migrate diff --from-url "$DIRECT_URL" \
  --to-schema-datamodel prisma/schema.prisma --script --exit-code   # empty
```

### 6. Point the service at the auth role

On the host, set `DATABASE_URL` to the pooler URL with `auth_svc` and its
password, still ending in `schema=auth`, and redeploy. Billing's variables do
not change. Then:

```bash
npm run smoke -- <auth url> <portal origin>
```

and sign in, refresh and sign out in a browser. `auth.auth_event` must show the
rows, read as the auth role.

### Rollback

Decide before step 3 that this is the way back, and use it if the auth role
cannot migrate or the service cannot sign anyone in as it:

1. Set the service's `DATABASE_URL` back to the billing role's URL. Do not
   redeploy yet.
2. `psql "$PSQL_URL" -X -f scripts/roles/90-rollback.sql`, as the billing role.
3. Redeploy, and smoke as in step 6.

The auth role is left behind, owning and reaching nothing. `DROP ROLE auth_svc`
if the split is being abandoned.

## A new database

A database built from nothing is built by billing's migrations, which create
schema `auth` and move the tables into it as the billing role. So a new
environment starts in the "before" state, and this runbook is part of setting
it up.

## Record

### Local rehearsal (2026-10-10)

A throwaway database on the developer machine's Postgres 18.6, with a
non-superuser `CREATEROLE` role standing in for the billing role and schema
`auth` built by this repo's first two migrations. Dropped afterwards. Nothing
ran against a real database.

| Check | Result |
|---|---|
| precheck all `t` | ✅ |
| role created, login-only | ✅ |
| transfer, as a non-superuser | ✅ |
| verify all `t`; `auth_event_id_seq` followed its table | ✅ |
| `prisma migrate deploy` as the auth role applied `account_types`, which runs `ALTER TABLE "account"` | ✅ |
| `prisma migrate diff` empty | ✅ |
| auth role inserts into and reads `auth_event` | ✅ |
| billing role: `SELECT * FROM auth.account` | `ERROR:  permission denied for schema auth` |
| billing role: `INSERT INTO auth.account_pin` | `ERROR:  permission denied for schema auth` |
| auth role: `SELECT * FROM billing.client` | `ERROR:  permission denied for schema billing` |
| rollback restores the billing role as owner; the auth role is then refused | ✅ |
| transfer again after a rollback | ✅ |

### Development precheck (2026-10-10) — stopped here

`00-precheck.sql` against Neon development, read-only. Nothing was changed.

| | |
|---|---|
| `foo_development_app` | owns the database, billing's 8 tables, and schema `auth` with its 4 tables |
| `dev_role_auth` | a second role, already there |
| both | members of `neon_superuser`, and through it of `pg_read_all_data` and `pg_write_all_data` |
| `auth_svc` | does not exist |

The two checks this runbook warns about printed `f`. Either role reads and
writes `auth.account` whatever the schema's privileges say, so the transfer
would leave billing's role able to do exactly what it was meant to stop, and
step 5's negative test would not be refused.

FA-22 was closed on that, with the split applied nowhere. Finishing it means a
plain role for billing as well as for this service, each made over SQL so that
neither joins `neon_superuser`, each owning its own schema; the two existing
roles would then be for people, not services. That moves billing's tables to a
new owner and changes billing's connection strings, which is why it was not
done as part of this story.

### Environments

| Environment | Date | Billing role passes the precheck | Negative test error | Sign-in as `auth_svc` |
|---|---|---|---|---|
| Neon branch from dev | | | | |
| Development | 2026-10-10 | no: member of `neon_superuser` | not run | not run |
| UAT | | | | |
| Production | | | | |
