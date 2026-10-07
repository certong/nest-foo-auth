# Runbook: deploying nest-foo-auth (FA-12)

Puts this service on its hostname in one environment and proves it from the
outside. Do development first, then UAT, then production; each is the same six
steps with a different column of the table below.

Deploying is spec 11.4 step 1 and nothing more: the service is up but **cannot
serve logins yet**, because `account` and `account_pin` are still in billing's
`public` schema. That is expected, and step 5 here passes without them. Moving
the tables is the cut-over, [`auth-table-handover.md`](auth-table-handover.md)
(FA-15 for UAT, FA-16 for production).

Nothing here has been run yet. Record each environment under "Deploy record" at
the bottom as it is done.

## What each environment is set to

| Variable | Development | UAT | Production |
|---|---|---|---|
| `APP_ENV` | `dev` | `uat` | `prod` |
| `AUTH_ISSUER` | `https://auth-api-dev.foocertong.com` | `https://auth-api-uat.foocertong.com` | `https://auth-api.foocertong.com` |
| `AUTH_PORTAL_ORIGINS` | `https://billing-dev.foocertong.com=billing` | `https://billing-uat.foocertong.com=billing` | `https://billing.foocertong.com=billing` |
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
- `ADMIN_*`, `USER_*`, `OPERATOR_*`, `TEST_DATABASE_URL`: read by scripts, never
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
on the end; without `schema=auth` Prisma reads `public`, which is billing's.

### 4. Point the hostname at it

Add the custom domain on the host, create the DNS record it asks for, and wait
for the certificate. Then deploy, and read the first line the service logs:

    listening on <port> — APP_ENV=dev db=<pooler host> issuer=https://auth-api-dev.foocertong.com

All three must be the environment you meant. A boot failure names the variable
that is wrong.

### 5. Smoke, without an account

```bash
npm run smoke -- https://auth-api-dev.foocertong.com https://billing-dev.foocertong.com
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

`0_init` refuses to run on a database whose tables are still in `public`, so
running `migrate deploy` too early stops with a message instead of doing harm.

Existing accounts move with the tables, so there is normally nothing to seed.
Then, with an account that exists there:

```bash
SMOKE_EMAIL=you@example.com SMOKE_PASSWORD=… \
  npm run smoke -- https://auth-api-dev.foocertong.com https://billing-dev.foocertong.com
```

Six more checks: sign in, the cookie's attributes (`HttpOnly`, `Secure`,
`SameSite=Lax`, `Path=/api/auth`, no `Domain`), `iss` equal to the URL, `/me`,
refresh, sign out. It is a real sign-in: it leaves `login_success`,
`portal_entry` and `logout` rows in `auth.auth_event` under one `sid`, which is
also the proof that the log is being written through the pooler (FA-17).

The script does not prove the browser sends the cookie back from the portal's
own host. That takes a click-through on the deployed billing frontend: sign in,
reload the page, and stay signed in.

## Rolling back

Before the cut-over nothing depends on this service, so rolling back is
redeploying the previous image or deleting the service. Changing
`AUTH_SIGNING_JWK` at any point signs everyone out everywhere.

## Deploy record

| Environment | Date | Image (commit) | `kid` | Step 5 | Step 6 |
|---|---|---|---|---|---|
| Development | | | | | |
| UAT | | | | | |
| Production | | | | | |
