-- account and account_pin, exactly as nest-foo-billing left them.
--
-- These tables were created by billing's migration history and moved here with
-- `ALTER TABLE ... SET SCHEMA auth` (docs/runbooks/auth-table-handover.md). Any
-- database that ever ran billing's migrations therefore already HAS them, and
-- this file is marked applied there, never run:
--
--     npx prisma migrate resolve --applied 0_init
--
-- It runs for real only on an empty database: this repo's own test database, a
-- scratch database, or the shadow database `prisma migrate dev` builds. So it
-- must describe the moved tables precisely — every constraint and index name
-- below matches billing's (after its rename migrations), and the two CHECKs on
-- account_pin, which Prisma cannot express, are carried over by hand.

-- Running this against a database that came from billing would fail halfway on
-- "relation already exists". Fail first, and say what to do instead.
--
-- Both sides are checked, because a billing database reaches this file in two
-- states. After the handover the tables are in auth, and the first branch sees
-- them. Before it they are still in billing's schema, and nothing here would
-- collide: the CREATE TABLE statements below are unqualified but run with
-- schema=auth, so 0_init would succeed and leave empty auth.account and
-- auth.account_pin beside the populated ones, with every real login stranded
-- in billing's schema and no error to say so. The second branch is what makes
-- that loud.
--
-- Billing's schema is `billing`. It was `public` until 2026-10-07, and a
-- database built before then stays that way until it is renamed by hand
-- (nest-foo-billing README, "Billing's schema"), so both names are looked in.
DO $$
BEGIN
  IF to_regclass('auth.account') IS NOT NULL OR to_regclass('auth.account_pin') IS NOT NULL THEN
    RAISE EXCEPTION 'auth.account already exists: this database came from nest-foo-billing. Do not run 0_init; mark it applied with `npx prisma migrate resolve --applied 0_init`.';
  END IF;

  IF to_regclass('billing.account') IS NOT NULL OR to_regclass('billing.account_pin') IS NOT NULL THEN
    RAISE EXCEPTION 'billing.account exists but auth.account does not: this database came from nest-foo-billing and the tables have not been moved yet. Running 0_init now would create empty tables in auth and leave every account in billing. Do the move first (docs/runbooks/auth-table-handover.md), then mark this applied with `npx prisma migrate resolve --applied 0_init`.';
  END IF;

  IF to_regclass('public.account') IS NOT NULL OR to_regclass('public.account_pin') IS NOT NULL THEN
    RAISE EXCEPTION 'public.account exists but auth.account does not: this database came from nest-foo-billing before its tables left public, and the handover has not run. Running 0_init now would create empty tables in auth and leave every account in public. Rename the schema to billing first (nest-foo-billing README, "Billing''s schema"), do the move (docs/runbooks/auth-table-handover.md), then mark this applied with `npx prisma migrate resolve --applied 0_init`.';
  END IF;
END $$;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_pin" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "account_id" UUID,
    "key_hash" VARCHAR(255),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "lockout_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pin_pkey" PRIMARY KEY ("id")
);

-- One row, forever. The primary key already stops a second row for any caller
-- that omits id; this stops one that passes id explicitly.
ALTER TABLE "account_pin"
  ADD CONSTRAINT "account_pin_singleton" CHECK ("id" = 1);

-- The key and the account it opens are set together or not at all. Without
-- this, deleting an account could leave a live Argon2 credential pointing at
-- nothing — and the correct PIN would then fail indistinguishably from a wrong
-- one, locking out the one person who knows it.
ALTER TABLE "account_pin"
  ADD CONSTRAINT "account_pin_pairing"
  CHECK (("key_hash" IS NULL) = ("account_id" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "account_email_key" ON "account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "account_pin_account_id_key" ON "account_pin"("account_id");

-- AddForeignKey
-- RESTRICT, not SET NULL: the database refuses to delete the account holding the
-- door until the key is explicitly cleared, which is what keeps the pairing
-- above satisfiable.
ALTER TABLE "account_pin" ADD CONSTRAINT "account_pin_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the singleton unconditionally. The row has to exist even where no PIN is
-- configured: the lockout counters are what make "no PIN set" indistinguishable
-- from "wrong PIN", and counters that are absent cannot count.
--
-- updated_at is supplied explicitly because Prisma's @updatedAt is applied by
-- the client and emits no database default, so a bare INSERT violates NOT NULL.
INSERT INTO "account_pin" ("id", "updated_at")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
