-- Shared by every script here: the two role names, as psql variables.
--
--   auth_role     the new owner of schema auth. Default auth_svc.
--   billing_role  the role that owns the tables today, which is the one every
--                 service connected as before FA-22. Default: whoever runs this.
--
-- Override with  psql -v auth_role=… -v billing_role=…
\if :{?auth_role}
\else
  \set auth_role auth_svc
\endif
\if :{?billing_role}
\else
  SELECT current_user AS billing_role \gset
\endif
