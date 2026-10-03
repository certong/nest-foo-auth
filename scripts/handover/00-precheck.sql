-- Read-only. Run before the move; every line should print t.
-- See docs/runbooks/auth-table-handover.md, step 1.
\set ON_ERROR_STOP on
\pset footer off
SELECT 'public.account exists'      AS check, to_regclass('public.account')     IS NOT NULL AS ok
UNION ALL SELECT 'public.account_pin exists', to_regclass('public.account_pin') IS NOT NULL
UNION ALL SELECT 'auth.account absent',       to_regclass('auth.account')       IS NULL
UNION ALL SELECT 'auth.account_pin absent',   to_regclass('auth.account_pin')   IS NULL
UNION ALL SELECT 'auth.auth_event absent',    to_regclass('auth.auth_event')    IS NULL
UNION ALL SELECT 'account_pin has one row',   (SELECT count(*) FROM public.account_pin) = 1
UNION ALL SELECT 'both CHECKs present',       (SELECT count(*) FROM pg_constraint
                                               WHERE conrelid = 'public.account_pin'::regclass
                                                 AND conname IN ('account_pin_singleton', 'account_pin_pairing')) = 2
UNION ALL SELECT 'no other table references account', NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE contype = 'f' AND confrelid = 'public.account'::regclass
    AND conrelid <> 'public.account_pin'::regclass);

-- Record these; step 5 compares against them.
SELECT (SELECT count(*) FROM public.account) AS accounts,
       (SELECT account_id FROM public.account_pin WHERE id = 1) AS pin_holder,
       (SELECT key_hash IS NOT NULL FROM public.account_pin WHERE id = 1) AS pin_set,
       (SELECT md5(string_agg(id::text || email || password_hash, ',' ORDER BY id)) FROM public.account) AS account_digest;
