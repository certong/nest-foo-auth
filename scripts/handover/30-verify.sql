-- Read-only. Run after `migrate resolve --applied 0_init` and `migrate deploy`.
-- Every check should print t. See the runbook, step 5.
\set ON_ERROR_STOP on
\pset footer off
SELECT 'public.account gone'          AS check, to_regclass('public.account')     IS NULL AS ok
UNION ALL SELECT 'public.account_pin gone',   to_regclass('public.account_pin') IS NULL
UNION ALL SELECT 'auth.account present',      to_regclass('auth.account')       IS NOT NULL
UNION ALL SELECT 'auth.account_pin present',  to_regclass('auth.account_pin')   IS NOT NULL
UNION ALL SELECT 'auth.auth_event present',   to_regclass('auth.auth_event')    IS NOT NULL
UNION ALL SELECT 'account_pin CHECKs kept',   (SELECT count(*) FROM pg_constraint
                                               WHERE conrelid = 'auth.account_pin'::regclass
                                                 AND conname IN ('account_pin_singleton', 'account_pin_pairing')) = 2
UNION ALL SELECT 'account_pin FK kept',       EXISTS (SELECT 1 FROM pg_constraint
                                               WHERE conname = 'account_pin_account_id_fkey'
                                                 AND conrelid = 'auth.account_pin'::regclass
                                                 AND confrelid = 'auth.account'::regclass)
UNION ALL SELECT 'auth_event CHECKs present', (SELECT count(*) FROM pg_constraint
                                               WHERE conrelid = 'auth.auth_event'::regclass AND contype = 'c'
                                                 AND conname LIKE 'auth_event_%_check') = 3
UNION ALL SELECT 'portal_entry partial unique index', EXISTS (SELECT 1 FROM pg_indexes
                                               WHERE schemaname = 'auth' AND indexname = 'auth_event_portal_entry_once'
                                                 AND indexdef LIKE '%WHERE%portal_entry%')
UNION ALL SELECT 'auth history: 0_init applied', EXISTS (SELECT 1 FROM auth._prisma_migrations
                                               WHERE migration_name = '0_init' AND finished_at IS NOT NULL)
UNION ALL SELECT 'billing history untouched', NOT EXISTS (SELECT 1 FROM public._prisma_migrations
                                               WHERE migration_name = '0_init' OR migration_name LIKE '%add_auth_event');

-- Same figures as the precheck printed; they must match.
SELECT (SELECT count(*) FROM auth.account) AS accounts,
       (SELECT account_id FROM auth.account_pin WHERE id = 1) AS pin_holder,
       (SELECT key_hash IS NOT NULL FROM auth.account_pin WHERE id = 1) AS pin_set,
       (SELECT md5(string_agg(id::text || email || password_hash, ',' ORDER BY id)) FROM auth.account) AS account_digest;

-- The rules still bite, not merely exist. Each probe must be refused; the
-- block raises if one is accepted. Inside a transaction that is rolled back, so
-- nothing it writes survives.
BEGIN;
DO $$
DECLARE probe uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO auth.account_pin (id, updated_at) VALUES (2, now());
    RAISE EXCEPTION 'account_pin_singleton accepted a second row';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE auth.account_pin SET key_hash = 'x', account_id = NULL WHERE id = 1;
    RAISE EXCEPTION 'account_pin_pairing accepted a key with no account';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO auth.auth_event (kind, portal) VALUES ('nonsense', 'billing');
    RAISE EXCEPTION 'auth_event_kind_check accepted an unknown kind';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO auth.auth_event (kind, portal, sid) VALUES ('portal_entry', 'billing', probe);
  INSERT INTO auth.auth_event (kind, portal, sid) VALUES ('portal_entry', 'studio', probe);
  INSERT INTO auth.auth_event (kind, portal, sid) VALUES ('logout', 'billing', probe);
  BEGIN
    INSERT INTO auth.auth_event (kind, portal, sid) VALUES ('portal_entry', 'billing', probe);
    RAISE EXCEPTION 'auth_event_portal_entry_once accepted a second portal_entry';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'rule probes: all refused as expected';
END $$;
ROLLBACK;
