-- The login log. Append-only; see AuthEvent in schema.prisma.

-- CreateTable
CREATE TABLE "auth_event" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID,
    "kind" VARCHAR(32) NOT NULL,
    "method" VARCHAR(16),
    "portal" VARCHAR(16) NOT NULL,
    "sid" UUID,
    "ip" INET,
    "user_agent" VARCHAR(512),

    CONSTRAINT "auth_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_event_account_id_created_at_idx" ON "auth_event"("account_id", "created_at" DESC);

-- CreateIndex
-- BRIN: rows arrive in created_at order, so a handful of summary pages lets the
-- retention sweep find "older than a year" without a full btree.
CREATE INDEX "auth_event_created_at_idx" ON "auth_event" USING BRIN ("created_at");

-- Hand-written from here down: Prisma has no syntax for any of it.

-- The values the code writes, enforced where a stray INSERT cannot skip them.
-- VARCHAR + CHECK rather than enum types, so adding a portal later is one
-- ALTER TABLE rather than ALTER TYPE.
ALTER TABLE "auth_event"
  ADD CONSTRAINT "auth_event_kind_check" CHECK ("kind" IN (
    'login_success', 'login_failed', 'key_failed', 'key_locked', 'portal_entry', 'logout'
  ));
ALTER TABLE "auth_event"
  ADD CONSTRAINT "auth_event_method_check" CHECK ("method" IS NULL OR "method" IN ('password', 'pin'));
ALTER TABLE "auth_event"
  ADD CONSTRAINT "auth_event_portal_check" CHECK ("portal" IN ('billing', 'studio'));

-- "Signed in to studio" is the first refresh from the studio origin, and every
-- refresh after it would otherwise add a row every fifteen minutes. One
-- portal_entry per session per portal, enforced here: the service inserts with
-- ON CONFLICT DO NOTHING on every login and refresh, and this index is what
-- turns all but the first into no-ops. Partial, so it says nothing about the
-- other kinds.
CREATE UNIQUE INDEX "auth_event_portal_entry_once" ON "auth_event" ("sid", "portal")
  WHERE "kind" = 'portal_entry';
