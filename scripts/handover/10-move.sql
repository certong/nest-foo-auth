-- The handover itself. Moves billing's two login tables into schema auth.
--
-- No rows are copied: SET SCHEMA rewrites one catalogue entry per table, and
-- the constraints, indexes (including the PG17+ named NOT NULLs), the two
-- CHECKs and the account_pin -> account foreign key all move with the table
-- because they belong to it, not to the schema. Neither table owns a sequence,
-- so nothing is left behind in public.
--
-- In UAT and production this exact SQL ships as a nest-foo-billing migration
-- instead (spec section 11.1); this file is for rehearsal and for local/dev.
--
-- Run over the DIRECT (non-pooler) connection. lock_timeout keeps it from
-- queueing behind a long transaction and stalling every login behind it.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SCHEMA IF NOT EXISTS auth;
ALTER TABLE public.account_pin SET SCHEMA auth;
ALTER TABLE public.account     SET SCHEMA auth;
COMMIT;
