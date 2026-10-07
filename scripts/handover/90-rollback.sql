-- Undo the handover: puts account and account_pin back in schema billing, drops the
-- login log and this repo's migration history.
--
-- Only valid while billing still expects to own them, i.e. before
-- billing's new release is live. auth_event rows are lost; that is the price
-- of going back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS auth.auth_event;
ALTER TABLE auth.account     SET SCHEMA billing;
ALTER TABLE auth.account_pin SET SCHEMA billing;
DROP TABLE IF EXISTS auth._prisma_migrations;
DROP SCHEMA auth;
COMMIT;
