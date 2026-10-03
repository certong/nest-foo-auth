# Account types implementation plan

**Spec:** `docs/superpowers/specs/2026-10-03-account-types-design.md` (approved
2026-10-03, decision 7.2 as recommended: disabling is in scope).

Global constraints from `2026-10-03-nest-foo-auth.md` still apply. Additive to the
response shapes: `{ id, email }` stays, `accountType` and `clientId?` join it.

- [x] **Migration** `20261003140000_account_types`: `account_type`, `client_id`,
  `disabled_at`, two CHECKs, index, `portal_denied` in the event CHECK.
  Rehearsed on the PG16/PG18 copies, and a fresh build is identical.
- [x] **`account-type.ts`**: types, `PORTAL_ACCESS`, `canEnter`, `portalDenied`. Spec first.
- [x] **Tokens**: `account_type` always, `client_id` for clients only. Verify
  rejects a missing or unknown type, a client without a positive integer id,
  and staff with an id.
- [x] **AuthService**:
  - a disabled account is a wrong password;
  - the portal check comes after the credential, at password, PIN and refresh;
  - refresh reads the row and refuses a disabled account or a type/client mismatch;
  - a denial writes `portal_denied`.
- [x] **Public shape**: `toAuthenticatedUser` for the login body and `/me`.
- [x] **Scripts**: `user:add` types, `user:disable`/`user:enable`, `user:list`
  columns; `key:set` and `seed:admin` refuse clients.
- [x] **Tests**: portal matrix e2e, cross-portal refresh, disable mid-session,
  re-scope, contract (studio reads `client_id`), script validation, DB CHECKs.
- [x] **Docs**: README, `.env.example`, spec §10, main spec §8 pointer.
- [ ] **On a machine with a Prisma engine**: `npx prisma migrate deploy` after the
  handover; `npm run test:db`.
