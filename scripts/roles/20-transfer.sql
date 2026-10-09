-- Hands schema auth and its tables to the auth role, and shuts everyone else
-- out. One transaction: all of it or none. Run as the role that owns the tables
-- today, over the DIRECT (non-pooler) connection.
--
-- Ownership has to move, not just privileges: this repo's migrations run
-- ALTER TABLE, which only an owner may do.
--
-- Postgres asks three things of whoever gives a table away, and the first four
-- statements are there to satisfy them:
--   * it must be able to become the new owner       -> the GRANT of the role
--   * the new owner must have CREATE on the database, to take a schema
--                                                   -> granted, then revoked
--   * the new owner must have CREATE on the schema, to take a table
--                                                   -> it owns the schema by then
--
-- The membership is revoked again at the end, and that line matters as much as
-- the REVOKE USAGE above it: a role that is a member of the auth role inherits
-- everything the auth role may do, schema or no schema.
\set ON_ERROR_STOP on
\pset footer off
\ir _vars.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

GRANT :"auth_role" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
SELECT format('GRANT CREATE ON DATABASE %I TO %I', current_database(), :'auth_role') \gexec

ALTER SCHEMA auth OWNER TO :"auth_role";
SELECT format('ALTER TABLE auth.%I OWNER TO %I', c.relname, :'auth_role')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p') ORDER BY c.relname \gexec

SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), :'auth_role') \gexec

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON SCHEMA auth FROM :"billing_role";
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM :"billing_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM :"billing_role";

REVOKE :"auth_role" FROM CURRENT_USER;
COMMIT;
