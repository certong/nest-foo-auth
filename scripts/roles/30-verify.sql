-- Read-only. Run after 20-transfer.sql, as the billing role. Every `ok` should
-- print t. See docs/runbooks/auth-svc-role.md, step 4.
--
-- These ask the catalogue what each role may do. The runbook's step 5 then
-- tries it for real, which is the proof; this is the faster thing to read.
\set ON_ERROR_STOP on
\pset footer off
\ir _vars.sql
SELECT 'schema auth owned by auth role' AS check, (SELECT pg_get_userbyid(nspowner) = :'auth_role'
                                                    FROM pg_namespace WHERE nspname = 'auth') AS ok
UNION ALL SELECT 'four tables, all owned by auth role', (SELECT count(*) = 4 AND bool_and(pg_get_userbyid(c.relowner) = :'auth_role')
                                                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                    WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p'))
UNION ALL SELECT 'every sequence followed its table',  NOT EXISTS (
                                                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                    WHERE n.nspname = 'auth' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) <> :'auth_role')
UNION ALL SELECT 'billing role: no USAGE on schema auth', NOT has_schema_privilege(:'billing_role', 'auth', 'USAGE')
UNION ALL SELECT 'billing role: no CREATE on schema auth', NOT has_schema_privilege(:'billing_role', 'auth', 'CREATE')
UNION ALL SELECT 'PUBLIC: no USAGE on schema auth',  NOT has_schema_privilege('public', 'auth', 'USAGE')
UNION ALL SELECT 'billing role: no privilege on any auth table', NOT EXISTS (
                                                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                    WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p')
                                                      AND has_table_privilege(:'billing_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
UNION ALL SELECT 'billing role is not a member of auth role', NOT pg_has_role(:'billing_role', :'auth_role', 'USAGE')
                                                  AND NOT pg_has_role(:'billing_role', :'auth_role', 'SET')
UNION ALL SELECT 'auth role is login-only',       (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
                                                    FROM pg_roles WHERE rolname = :'auth_role')
UNION ALL SELECT 'auth role: no CREATE on the database', NOT has_database_privilege(:'auth_role', current_database(), 'CREATE')
UNION ALL SELECT 'auth role: no USAGE on schema billing', to_regnamespace('billing') IS NULL
                                                  OR NOT has_schema_privilege(:'auth_role', 'billing', 'USAGE');
