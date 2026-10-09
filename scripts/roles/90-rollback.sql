-- Undo 20-transfer.sql: schema auth and its tables go back to the role running
-- this, which must be the one that created the auth role (it kept the right to
-- administer it). One transaction, DIRECT connection.
--
-- Use this if the auth role cannot migrate or the service cannot sign anyone in
-- as it. Point DATABASE_URL and DIRECT_URL back at the old role FIRST: once this
-- commits the auth role can read nothing, and a service still connected as it
-- answers 500 to every login.
--
-- The auth role itself is left in place, owning and able to reach nothing.
-- Drop it afterwards with DROP ROLE if the split is being abandoned.
\set ON_ERROR_STOP on
\pset footer off
\ir _vars.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

GRANT :"auth_role" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
ALTER SCHEMA auth OWNER TO CURRENT_USER;
SELECT format('ALTER TABLE auth.%I OWNER TO CURRENT_USER', c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p') ORDER BY c.relname \gexec
REVOKE :"auth_role" FROM CURRENT_USER;
COMMIT;
