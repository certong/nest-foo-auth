#!/usr/bin/env bash
#
# Rehearses the account/account_pin handover against the database the active
# .env points at (docs/runbooks/auth-table-handover.md).
#
#   npm run env:local            # or env:dev — never uat/prod
#   scripts/handover/rehearse.sh
#
# Steps: precheck -> move -> prisma migrate resolve --applied 0_init ->
# prisma migrate deploy -> verify -> drift check. Stops at the first failure.
# Undo with:  psql "$PSQL_URL" -f scripts/handover/90-rollback.sql
#
# Needs psql on PATH (Homebrew: brew install libpq, or postgresql@17).
set -euo pipefail
cd "$(dirname "$0")/../.."
here=scripts/handover

if [[ ! -e .env ]]; then
  echo "no .env -- run 'npm run env:local' (or env:dev) first" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# The brief: local or dev only. UAT and production are never rehearsed from
# here; their move ships as a nest-foo-billing migration.
case "${APP_ENV:-}" in
  local | dev) ;;
  *)
    echo "APP_ENV=${APP_ENV:-unset}: this script runs only against local or dev." >&2
    exit 1
    ;;
esac

if [[ "${DIRECT_URL:-}" != *"schema=auth"* || "${DATABASE_URL:-}" != *"schema=auth"* ]]; then
  echo "DATABASE_URL and DIRECT_URL must both end in schema=auth (see .env.example)." >&2
  exit 1
fi

# psql rejects Prisma's `schema` URL parameter; strip it and keep the rest
# (sslmode, channel_binding) intact.
PSQL_URL=$(printf '%s' "$DIRECT_URL" | sed -E 's/([?&])schema=auth(&|$)/\1/; s/[?&]$//')
export PSQL_URL
host=$(printf '%s' "$DIRECT_URL" | sed -E 's#^[a-z]+://[^@]*@([^/]+)/.*#\1#')

echo "== target: APP_ENV=$APP_ENV host=$host"
echo "== 1. precheck"
psql "$PSQL_URL" -X -q -f "$here/00-precheck.sql"

read -r -p "Every check above t, and the figures recorded? Move the tables on $host? [y/N] " answer
[[ "$answer" == "y" ]] || { echo "stopped before the move"; exit 1; }

echo "== 2. move"
psql "$PSQL_URL" -X -q -f "$here/10-move.sql"

echo "== 3. baseline: 0_init is already true of this database"
npx prisma migrate resolve --applied 0_init

echo "== 4. forward: create auth_event"
npx prisma migrate deploy

echo "== 5. verify (compare the figures with step 1)"
psql "$PSQL_URL" -X -q -f "$here/30-verify.sql"

echo "== 6. drift: schema.prisma against the database (no output = none)"
# Exit code 2 means a difference — including Prisma wanting to drop the
# partial unique index it cannot represent. That is a finding, not noise.
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script --exit-code

echo "== handover rehearsed on $host"
