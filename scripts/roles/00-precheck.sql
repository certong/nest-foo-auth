-- Read-only. Run before anything else, as the role that owns the tables today.
-- Every `ok` should print t. See docs/runbooks/auth-svc-role.md, step 1.
--
-- The last two checks are the ones that decide whether this story can work at
-- all: a superuser, or a member of pg_read_all_data, reads every table whatever
-- a schema's privileges say, so revoking USAGE from such a role refuses nothing.
\set ON_ERROR_STOP on
\pset footer off
\ir _vars.sql
SELECT 'running as the billing role' AS check, current_user = :'billing_role' AS ok
UNION ALL SELECT 'schema auth exists',            to_regnamespace('auth') IS NOT NULL
UNION ALL SELECT 'schema auth owned by billing role', (SELECT pg_get_userbyid(nspowner) = :'billing_role'
                                                    FROM pg_namespace WHERE nspname = 'auth')
UNION ALL SELECT 'four tables, all owned by billing role', (SELECT count(*) = 4 AND bool_and(pg_get_userbyid(c.relowner) = :'billing_role')
                                                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                    WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p')
                                                      AND c.relname IN ('account', 'account_pin', 'auth_event', '_prisma_migrations'))
UNION ALL SELECT 'nothing else in schema auth',   NOT EXISTS (
                                                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                    WHERE n.nspname = 'auth' AND c.relkind NOT IN ('i', 'I')
                                                      AND c.relname NOT IN ('account', 'account_pin', 'auth_event', '_prisma_migrations')
                                                      -- a column's own sequence follows its table to the new owner
                                                      AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d
                                                        WHERE d.objid = c.oid AND d.deptype IN ('a', 'i') AND d.refclassid = 'pg_class'::regclass)))
                                                  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                                    WHERE n.nspname = 'auth')
UNION ALL SELECT 'no foreign key crosses the schema', NOT EXISTS (
                                                    SELECT 1 FROM pg_constraint k
                                                    JOIN pg_class a ON a.oid = k.conrelid  JOIN pg_namespace an ON an.oid = a.relnamespace
                                                    JOIN pg_class b ON b.oid = k.confrelid JOIN pg_namespace bn ON bn.oid = b.relnamespace
                                                    WHERE k.contype = 'f' AND (an.nspname = 'auth') <> (bn.nspname = 'auth'))
UNION ALL SELECT 'billing role may create roles', (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = :'billing_role')
UNION ALL SELECT 'billing role is not a superuser', (SELECT NOT rolsuper FROM pg_roles WHERE rolname = :'billing_role')
UNION ALL SELECT 'billing role lacks pg_read_all_data',  NOT pg_has_role(:'billing_role', 'pg_read_all_data', 'USAGE')
UNION ALL SELECT 'billing role lacks pg_write_all_data', NOT pg_has_role(:'billing_role', 'pg_write_all_data', 'USAGE');

-- For the record: who owns what now, and whether the new role is already there.
SELECT n.nspname AS schema, c.relname AS "table", pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p') ORDER BY 2;
SELECT :'auth_role' AS auth_role, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'auth_role') AS already_exists,
       :'billing_role' AS billing_role,
       (SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) FROM pg_roles r
        WHERE r.rolname <> :'billing_role' AND pg_has_role(:'billing_role', r.oid, 'MEMBER')) AS billing_role_member_of;
