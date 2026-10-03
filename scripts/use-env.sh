#!/usr/bin/env bash
#
# Points .env at one of the per-target env files, so that both `nest start` and
# the Prisma CLI (which reads .env directly and knows nothing about Nest's
# ConfigModule) always agree on which database they are talking to.
#
#   scripts/use-env.sh uat     -> .env -> .env.uat
#   scripts/use-env.sh         -> print the active target
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -e .env && -z "${1:-}" ]]; then
  echo "no .env -- run 'npm run env:local' (or :dev / :uat) to pick one" >&2
  exit 1
fi

# No argument: report which target is active and stop.
if [[ -z "${1:-}" ]]; then
  if [[ -L .env ]]; then
    echo "active env: $(readlink .env)"
  else
    echo "active env: .env is a regular file, not a symlink to a target" >&2
    exit 1
  fi
  exit 0
fi

target=".env.$1"

if [[ ! -f $target ]]; then
  echo "no such env file: $target" >&2
  echo "available: $(ls .env.* 2>/dev/null | grep -vE '\.(example|bak.*)$' | tr '\n' ' ')" >&2
  exit 1
fi

# Refuse to clobber a real .env that was never part of this scheme; losing an
# uncommitted, gitignored file is not recoverable.
if [[ -e .env && ! -L .env ]]; then
  echo ".env is a regular file, not a symlink. Move it aside first:" >&2
  echo "  mv .env .env.bak-preswitch" >&2
  exit 1
fi

ln -sfn "$target" .env
echo "active env: $target"
