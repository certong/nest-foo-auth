-- One PIN per account (FA-24, email + PIN sign-in).
--
-- account_pin was a singleton door: one row (CHECK id = 1) holding one PIN that
-- pointed at one account, plus that door's lockout counters. It becomes one row
-- per account that has a PIN, keyed by account_id. The lockout moves to memory
-- (src/auth/pin-lockout.ts), keyed by typed email, so its columns go.
--
-- Altered in place rather than recreated, so the table keeps its owner and
-- grants (docs/runbooks/auth-svc-role.md).

-- The seed row, and any door with no PIN set, become nothing: an account with
-- no PIN simply has no row. A door that has a PIN stays, and is now that
-- account's own PIN — so the PIN that worked before keeps working for the
-- account that held it.
DELETE FROM "account_pin" WHERE "key_hash" IS NULL OR "account_id" IS NULL;

ALTER TABLE "account_pin"
  DROP CONSTRAINT "account_pin_singleton",
  DROP CONSTRAINT "account_pin_pairing",
  DROP CONSTRAINT "account_pin_account_id_fkey",
  DROP CONSTRAINT "account_pin_pkey";

-- The unique index existed only to make the old relation one-to-one; the new
-- primary key does that job.
DROP INDEX "account_pin_account_id_key";

ALTER TABLE "account_pin"
  DROP COLUMN "id",
  DROP COLUMN "failed_attempts",
  DROP COLUMN "locked_until",
  DROP COLUMN "lockout_count";

ALTER TABLE "account_pin" RENAME COLUMN "key_hash" TO "pin_hash";

ALTER TABLE "account_pin"
  ALTER COLUMN "account_id" SET NOT NULL,
  ALTER COLUMN "pin_hash" SET NOT NULL,
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "account_pin" ADD CONSTRAINT "account_pin_pkey" PRIMARY KEY ("account_id");

-- CASCADE, not RESTRICT: with one PIN per account, a PIN means nothing without
-- its account, and there is no longer a shared door to protect from deletion.
ALTER TABLE "account_pin" ADD CONSTRAINT "account_pin_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
