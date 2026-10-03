-- Staff and client logins (docs/superpowers/specs/2026-10-03-account-types-design.md).
--
-- account_type says what kind of login a row is; client_id says which billing
-- client a client login belongs to; disabled_at cuts a login off without
-- deleting it. The default 'staff' keeps every existing row valid, so there is
-- no backfill: everyone who could sign in before is staff.

-- AlterTable
ALTER TABLE "account"
  ADD COLUMN "account_type" VARCHAR(16) NOT NULL DEFAULT 'staff',
  ADD COLUMN "client_id"    INTEGER,
  ADD COLUMN "disabled_at"  TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "account_client_id_idx" ON "account"("client_id");

-- Hand-written from here down: Prisma has no syntax for CHECK constraints.

ALTER TABLE "account"
  ADD CONSTRAINT "account_type_check" CHECK ("account_type" IN ('staff', 'client'));

-- A client login always names its client; a staff login never does. client_id
-- is public.client.id, deliberately without a foreign key: this service never
-- reads billing's schema.
ALTER TABLE "account"
  ADD CONSTRAINT "account_client_pairing"
  CHECK (("account_type" = 'client') = ("client_id" IS NOT NULL));

-- A client refused at a portal it may not enter is logged as portal_denied.
ALTER TABLE "auth_event" DROP CONSTRAINT "auth_event_kind_check";
ALTER TABLE "auth_event"
  ADD CONSTRAINT "auth_event_kind_check" CHECK ("kind" IN (
    'login_success', 'login_failed', 'key_failed', 'key_locked', 'portal_entry', 'logout', 'portal_denied'
  ));
