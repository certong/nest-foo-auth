#!/bin/sh
#
# Regenerates the Prisma client when an operation moved prisma/schema.prisma.
#
# The generated client lives in node_modules and is not tracked, so git will
# happily leave it describing a schema that is no longer checked out. What that
# looks like is a wall of TS2339 "property does not exist" errors in services
# nobody touched — a confusing way to learn that the client is stale.
#
# Called by the post-checkout, post-merge and post-rewrite hooks with the two
# revisions to compare.
set -e

old_rev="$1"
new_rev="$2"

# Nothing to compare against (a fresh clone, or a ref git could not resolve).
if [ -z "$old_rev" ] || [ -z "$new_rev" ]; then
  exit 0
fi

if git diff --quiet "$old_rev" "$new_rev" -- prisma/schema.prisma 2>/dev/null; then
  exit 0
fi

echo "prisma/schema.prisma changed — regenerating the Prisma client..."
# Never fail the git operation. The checkout or merge has already happened;
# turning a generation problem into a hook error would only obscure that.
#
# The failure to expect on Windows is EPERM renaming query_engine-windows.dll:
# a running `nest start` has the engine loaded and the file cannot be replaced
# under it. That is precisely when people switch branches, so the message names
# the cause rather than leaving them to read a rename error.
if ! npx prisma generate; then
  echo
  echo "prisma generate failed — the Prisma client is now STALE."
  echo "On Windows an EPERM on query_engine-windows.dll means the dev server"
  echo "still has it open. Stop 'npm run start:dev', then:"
  echo "    npm run prisma:generate"
fi

# Migrations that ship with the new schema still have to be applied by hand:
# this hook only keeps the generated types in step, and will not touch a
# database on its own.
if ! git diff --quiet "$old_rev" "$new_rev" -- prisma/migrations 2>/dev/null; then
  echo "Migrations also changed — run 'npx prisma migrate deploy' if the database is behind."
fi
