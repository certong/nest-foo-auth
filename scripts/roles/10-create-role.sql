-- Creates the role that will own schema auth. It can log in and nothing else:
-- no superuser, no CREATEDB, no CREATEROLE. Safe to re-run; an existing role is
-- left alone, password included.
--
--   AUTH_SVC_PASSWORD=… psql "$PSQL_URL" -X -v auth_svc_password="$AUTH_SVC_PASSWORD" \
--     -f scripts/roles/10-create-role.sql
--
-- The password is one per environment and belongs only in that environment's
-- secrets. It reaches the server inside the statement, so do not run this with
-- psql's -a or -e, which would print it.
\set ON_ERROR_STOP on
\pset footer off
\ir _vars.sql
\if :{?auth_svc_password}
\else
  \echo 'auth_svc_password is not set: pass -v auth_svc_password="$AUTH_SVC_PASSWORD"'
  \quit
\endif
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              :'auth_role', :'auth_svc_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'auth_role') \gexec
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = :'auth_role';
