# Runbook: deploying nest-foo-auth (FA-12)

Puts this service on its hostname in one environment and proves it from the
outside. Do development first, then UAT, then production; each is the same six
steps with a different column of the table below.

Deploying is spec 11.4 step 1 and nothing more: the service is up but **cannot
serve logins yet**, because `account` and `account_pin` are still in billing's
`billing` schema. That is expected, and step 5 here passes without them. Moving
the tables is the cut-over, [`auth-table-handover.md`](auth-table-handover.md)
(FA-15 for UAT, FA-16 for production).

All three environments are deployed and cut over as of 2026-10-09; see "Deploy
record" at the bottom. Record any later redeploy there as it is done.

## What each environment is set to

| Variable | Development | UAT | Production |
|---|---|---|---|
| `APP_ENV` | `dev` | `uat` | `prod` |
| `AUTH_ISSUER` | `https://api-auth-development.foocertong.com` | `https://api-auth-uat.foocertong.com` | `https://api-auth.foocertong.com` |
| `AUTH_PORTAL_ORIGINS` | `https://billing-development.foocertong.com=billing` | `https://billing-uat.foocertong.com=billing` | `https://billing.foocertong.com=billing` |
| `AUTH_SIGNING_JWK` | its own key | its own key | its own key |
| `DATABASE_URL` | Neon dev, **pooler** host, `…&schema=auth` | Neon UAT, the same | Neon production, the same |

The same in every environment:

| Variable | Value | Why |
|---|---|---|
| `AUTH_COOKIE_SECURE` | `true` | every deployed host is https; left `false`, the refresh cookie goes out without `Secure` |
| `AUTH_COOKIE_SAMESITE` | `lax` | every host is under `foocertong.com`, so the portals are same-site with this service |
| `TRUST_PROXY` | `1` | one proxy hop in front of the container; without it the login throttle is one global budget and every `auth_event` row records the proxy's IP |
| `AUTH_PUBLISHED_JWKS` | empty | only used while rotating the signing key |

Leave these unset on the host:

- `PORT`: the host injects it and `main.ts` reads it.
- `DIRECT_URL`: only `prisma migrate` reads it, and the image has no Prisma CLI.
  Migrations run from a laptop (step 6 and the handover runbook).
- `CORS_MAX_AGE`, `AUTH_EVENT_RETENTION_DAYS`: the defaults (600 seconds, 365
  days) are the intended values.
- `ADMIN_*`, `USER_*`, `TEST_DATABASE_URL`: read by scripts, never
  at runtime.

Two rules that are easy to get wrong:

- `AUTH_ISSUER` is the public URL exactly: https, no trailing slash, no path.
  It goes in every token as `iss`, and billing's `AUTH_ISSUER` must equal it
  character for character.
- **One instance.** The login throttle is in memory, per instance (spec 16).
  Two instances double the budget and split it at random. Turn autoscaling off.

## Steps

### 1. Create the service on the host

Build from this repo's `Dockerfile`, on the branch for the environment:
`development`, `uat` or `main`. The image listens on `PORT`. Health check path:
`/api/health` (it needs no `Origin` and touches no database).

### 2. Generate the signing key

```bash
SIGNING_KEY_ID=dev-2026-10 npm run signing-key:generate
```

One key per environment, never shared between two. Name the environment in the
`kid` so a token's header says where it was issued. Paste the `AUTH_SIGNING_JWK`
value into the host's secret store, without the surrounding quotes if the host
adds its own. It is printed once and written nowhere: keep no copy outside the
host. The service refuses to boot on a key that is not a P-256 private JWK with
a `kid`.

### 3. Set the variables

From the two tables above. `DATABASE_URL` is the pooler URL with `schema=auth`
on the end; without `schema=auth` Prisma reads `public`, which is empty (billing's tables are in `billing`).

### 4. Point the hostname at it

Add the custom domain on the host, create the DNS record it asks for, and wait
for the certificate. Then deploy, and read the first line the service logs:

    listening on <port> — APP_ENV=dev db=<pooler host> issuer=https://api-auth-development.foocertong.com

All three must be the environment you meant. A boot failure names the variable
that is wrong.

### 5. Smoke, without an account

```bash
npm run smoke -- https://api-auth-development.foocertong.com https://billing-development.foocertong.com
```

Seven checks, no account and no database needed: health, the JWKS (ES256 public
keys only, with the `kid` from step 2), CORS for the portal origin and for no
other, 403 without an allowlisted `Origin`, 401 for a refresh with no cookie.
All seven must be `ok`.

This is where FA-12 ends for an environment whose tables have not moved.

### 6. After the tables have moved: migrate, seed, smoke the sign-in

Only once the handover runbook's move has run in this environment. From a
laptop, with `.env.<name>` pointing at it (`npm run env:which` to be sure):

```bash
npx prisma migrate resolve --applied 0_init   # handover runbook, step 3
npx prisma migrate deploy                     # step 4
```

`0_init` refuses to run on a database whose tables are still in billing's schema, so
running `migrate deploy` too early stops with a message instead of doing harm.

Existing accounts move with the tables, so there is normally nothing to seed.
Then, with an account that exists there:

```bash
SMOKE_EMAIL=you@example.com SMOKE_PIN=… \
  npm run smoke -- https://api-auth-development.foocertong.com https://billing-development.foocertong.com
```

Six more checks: sign in, the cookie's attributes (`HttpOnly`, `Secure`,
`SameSite=Lax`, `Path=/api/auth`, no `Domain`), `iss` equal to the URL, `/me`,
refresh, sign out. It is a real sign-in: it leaves `login_success`,
`portal_entry` and `logout` rows in `auth.auth_event` under one `sid`, which is
also the proof that the log is being written through the pooler (FA-17).

The script does not prove the browser sends the cookie back from the portal's
own host. That takes a click-through on the deployed billing frontend: sign in,
reload the page, and stay signed in.

### 7. The PIN-only upgrade (FA-24, FA-25, and the end of password sign-in)

For an environment whose last deploy predates 2026-10-15. All three were last
deployed on 2026-10-09, so this applies to every one of them.

Three changes land together and they interact:

- **FA-24** replaces the singleton `account_pin` door with one PIN per account
  (`20261015120000_per_account_pin`).
- **FA-25** lets billing sign in with a PIN and no email, by resolving the one
  account it could belong to.
- **Password sign-in is retired.** `POST /api/auth/login` answers 403 at every
  portal. **There is no fallback left**: an account without a PIN cannot sign in
  at all, and a PIN lockout can no longer be cleared by proving a password.

Do not skip the before-and-after account census. The migration keeps **at most
one** PIN — the old shared door's — and every other account comes out of it with
no way in.

**Before.** With `.env.<name>` pointing at the environment (`npm run env:which`
to be sure), record who exists and who holds the old door:

```bash
npm run user:list
```

**Migrate.**

```bash
npx prisma migrate status    # expect only 20261015120000_per_account_pin pending
npx prisma migrate deploy
```

That migration deletes `account_pin` rows with no `key_hash` or no `account_id`
(the seed row, and any door never set), renames `key_hash` to `pin_hash`, and
re-keys the table by `account_id`. A door that had a PIN stays, and becomes that
account's own PIN — so exactly one account comes through still able to sign in,
and only if the door had been set.

**After.** Run the census again and read it against two rules:

```bash
npm run user:list
```

1. **Billing needs exactly one operator.** FA-25 counts accounts that are
   `staff`, not disabled, and hold a PIN. Zero or more than one and it refuses
   with the same 401 a wrong PIN gets — deliberately, so the endpoint cannot be
   used to count accounts, which also means the log will not tell you this is
   why. Straight after the migration the usual failure is **zero**, not two:
   two is unreachable until a second `key:set` is run. Zero happens when the old
   door belonged to a client account, or to one since disabled.
2. **Everyone else needs a PIN.** Every account that is not the one the door
   came with has none. Studio takes email + PIN, so each studio user is locked
   out until given one:

```bash
USER_EMAIL=someone@example.com USER_PIN=123456 npm run key:set
```

Setting a second **staff** PIN is what breaks rule 1. If billing and studio need
separate people, make the extra accounts `client`, or accept that billing's
PIN-alone door closes and its frontend must send the email again.

**Smoke.** Email and PIN, not a password:

```bash
SMOKE_EMAIL=you@example.com SMOKE_PIN=123456 \
  npm run smoke -- https://api-auth-development.foocertong.com https://billing-development.foocertong.com
```

Then the one thing the script does not cover, since it always sends the email —
billing's PIN-alone door, which is what the deployed frontend actually uses:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://api-auth-development.foocertong.com/api/auth/pin \
  -H 'Origin: https://billing-development.foocertong.com' \
  -H 'Content-Type: application/json' \
  -d '{"pin":"123456"}'
```

`200` means the operator resolved. `401` means rule 1 is not satisfied — go back
to the census; it is not a wrong PIN.

**Order against the frontend.** Deploy auth first. It still accepts
`{ email, pin }`, so a billing frontend from before CP-107 keeps working across
the gap. The reverse does not hold: CP-107 sends `{ pin }` alone and needs FA-25
already live, so promoting the frontend first takes billing sign-in down.

**Rolling back** is the image, as below — but only until `key:set` has been run
for anyone. The migration is not reversed by rolling the image back, and the
previous image cannot read `pin_hash`.

## Rolling back

Before the cut-over nothing depends on this service, so rolling back is
redeploying the previous image or deleting the service. Changing
`AUTH_SIGNING_JWK` at any point signs everyone out everywhere.

## Deploy record

| Environment | Date | Image (commit) | `kid` | Step 5 | Step 6 |
|---|---|---|---|---|---|
| Development | 2026-10-09 | `5269555` | `2026-10-07` | 7/7 ok | migrated; PIN sign-in by hand, 2026-10-09 |
| UAT | 2026-10-09 | `22efe30` | `uat-2026-10` | 7/7 ok | migrated; PIN sign-in by hand, 2026-10-09 |
| Production | 2026-10-09 | `b33e45f` | `prod-2026-10` | 7/7 ok | migrated; PIN sign-in by hand, 2026-10-09 |

Step 6 above records what is known, which is less than the step asks for. The
tables moved and `migrate deploy` ran in each environment, and the owner signed
in with the PIN in a browser, refreshed, signed out and signed in again. Whether
the scripted smoke (`npm run smoke` with `SMOKE_EMAIL`, the six further checks)
was run was not recorded, so no count is given for it. Production's move was
the cut-over itself: until it ran, `POST /api/auth/key` failed there with
`The table auth.account_pin does not exist`.
