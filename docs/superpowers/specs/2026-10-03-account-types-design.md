# Account types: staff and client logins

Date: 2026-10-03
Status: approved 2026-10-03 with 7.2 as recommended (disabling is in); built
Amends: `2026-10-03-nest-foo-auth-design.md` (reopens its "every account may
enter every portal, no roles" decision, on request)

## 1. The requirement

- **Billing** is staff-only. Today that means Chi alone.
- **Studio** is used by staff and by **clients**. A client sees only its own
  data there.
- A client is a login that belongs to one billing client (`billing.client.id`).
- Client business data (company, address, contacts, invoices) stays in billing.
  Auth stores only who can sign in, what type of login it is, and which client
  it belongs to. There is no `nest-foo-client` service for now.

## 2. Data model

Three columns on `auth.account`:

| Column | Type | Meaning |
|---|---|---|
| `account_type` | `VARCHAR(16) NOT NULL DEFAULT 'staff'`, CHECK in (`staff`, `client`) | What kind of login this is. Readable at a glance in any query |
| `client_id` | `INTEGER NULL` | The billing client this login belongs to (`billing.client.id`). Set only for client logins |
| `disabled_at` | `TIMESTAMP(3) NULL` | Set when the login is cut off (decision 7.2). Login and refresh refuse it |

```sql
ALTER TABLE auth.account
  ADD COLUMN account_type VARCHAR(16) NOT NULL DEFAULT 'staff',
  ADD COLUMN client_id    INTEGER;
ALTER TABLE auth.account
  ADD CONSTRAINT account_type_check CHECK (account_type IN ('staff', 'client'));
-- A client login always names its client; a staff login never does.
ALTER TABLE auth.account
  ADD CONSTRAINT account_client_pairing
  CHECK ((account_type = 'client') = (client_id IS NOT NULL));
CREATE INDEX account_client_id_idx ON auth.account (client_id);
```

- The default `'staff'` keeps every existing row valid, so the migration needs
  no backfill.
- `client_id` deliberately has **no foreign key** to `billing.client`. Auth
  never reads billing's schema (Decided in the main spec). The cost: deleting a
  billing client does not remove its logins. Section 7.2 covers that.
- Several logins may share one `client_id` (two people at the same client
  company).
- The PIN door (`account_pin`) stays staff-only. `key:set` refuses a client
  account.

## 3. Who may enter which portal

| account_type | billing | studio |
|---|---|---|
| `staff` | ✅ | ✅ |
| `client` | ❌ | ✅ |

One table in code (`PORTAL_ACCESS`), checked in **three** places. Checking only
at login is not enough, because of single sign-on:

1. **Login and PIN login.** A client signing in from the billing origin is
   refused **after** the password checks out.
2. **Refresh.** This is the one that matters. A client signs in at studio, and
   the billing frontend then calls `/auth/refresh` with the same shared cookie.
   Without a check here, that would mint a billing token. The account type
   travels in the refresh token, so the check needs no database read.
3. **`/me`** follows from (2): a client can never hold a billing token.

**Refusal response:** `403 { message: 'This account cannot sign in to this portal' }`.

- It is a 403, not a 401, because the credentials were right. A 401 would make
  the frontend say "wrong password".
- It does not leak whether the email exists: an unknown email still gets the
  usual identical 401, before this check is reached.
- Log row: a new kind `portal_denied` (account, portal, sid where known). No
  `portal_entry` is written.

## 4. Tokens

Two claims are added to access and refresh tokens:

| Claim | Value |
|---|---|
| `account_type` | `staff` or `client` |
| `client_id` | the billing client id (number). **Present only when** `account_type` is `client` |

- Spelled out in full rather than `typ`-style abbreviations, so they read at a
  glance in a decoded token. `typ` already means access/refresh. Reusing a
  short name like `type` would invite confusion.
- `/me` and the login response gain `accountType` (and `clientId` for
  clients). This is additive: the billing frontend's existing `{ id, email }`
  typing keeps working.

## 5. Contract changes for the product backends

The spec §8 contract gains:

- **Read** `account_type`. It must be `staff` or `client`, otherwise 401.
- If it is `client`, **require** `client_id` to be a positive integer,
  otherwise 401.
- **Billing:** accept `staff` only. Its `aud` already guarantees this, since a
  client can never obtain a billing token, but checking the type as well is
  cheap defence in depth.
- **Studio:** a `staff` token sees everything. A `client` token sees only rows
  where `client_id = token.client_id`. Studio must apply this filter in its
  data layer, not per controller. That rule belongs in studio's own design.

## 6. Admin scripts

- **`user:add`** gains `USER_ACCOUNT_TYPE` (default `staff`) and `USER_CLIENT_ID`
  (required for `client`, refused for `staff`). It does not check that the
  client id exists in billing. The script prints a reminder to confirm it.
- **`user:list`** shows the type and client id.
- **`seed:admin`** always creates or keeps `staff`. It refuses to reset a client
  account's password, so it can never turn one into the admin.

## 7. Decisions I made (please review)

1. **Column name `account_type`, values `staff` / `client`.** `staff` rather
   than `admin`: if you later add a teammate who should not be a full admin,
   `admin` becomes wrong for them, while `staff` still fits. Real roles inside
   staff would be a later, separate column.
2. **Cutting off a client.** With no foreign key, deleting a billing client
   leaves its logins able to sign in. Studio would then show them nothing, but
   they still get in. Today there is no way to disable a login short of a
   manual `DELETE FROM auth.account`. Client logins make offboarding a real
   need, so I recommend adding it **in this change**: a `disabled_at
   TIMESTAMP(3) NULL` column, a `user:disable` / `user:enable` script, and
   both login and refresh refusing a disabled account. One catch: refresh
   currently reads no database row (main spec), so a disabled client keeps its
   session for up to 12 hours unless refresh gains one indexed lookup. My
   proposal is to add that lookup. Say if you would rather defer all of this.
3. **403 for a portal denial**, after the password is verified (section 3).
4. **New log kind `portal_denied`.** Adding it means adding it to the
   `auth_event` CHECK.
5. **Client accounts cannot hold the PIN.**

## 8. Not in this change

Creating client logins from a screen (invite emails, an admin API), roles
within staff, and anything in the studio repo.

## 9. Migration and rollout

- One migration: the two columns, two CHECKs, the index, and the extended
  `auth_event_kind_check`. Existing tokens lack `account_type`.
- Verifiers treat a token with no `account_type` as invalid, so everyone signs in
  once more after deploy. That is acceptable at this stage; say if it is not,
  and staff-without-claim can be accepted for 12 hours instead.
- Tests: the portal matrix at login, PIN, refresh and `/me`; refresh across
  portals refused for a client; claims present or absent by type; CHECKs in the
  DB suite; script validation.

## 10. As built

- Migration `20261003140000_account_types`: the three columns, both CHECKs, the
  `client_id` index, and `portal_denied` added to `auth_event_kind_check`.
  Rehearsed on the PG16 and PG18 copies after the handover. The probes refuse a
  client without a client id, staff with one, and an unknown type. A fresh
  build of all three migrations is structurally identical to the upgraded
  copy.
- A **disabled** account fails sign-in exactly like a wrong password (same 401
  body, same Argon2 cost, a `login_failed` row). A disabled PIN holder is a door
  that opens nothing: counted and locked like a wrong key.
- **Refresh** reads the account by primary key. It refuses (401) a missing or
  disabled account, and a token whose `account_type` or `client_id` no longer
  matches the row. It then applies the portal table (403 + `portal_denied`).
- The portal table is in `src/auth/account-type.ts`. Claims are built and
  checked in `session-token.ts`. The public user shape is built in
  `authenticated-user.ts`, which never emits `sid` and emits `clientId` only for
  clients.
- Scripts: `user:add` takes `USER_ACCOUNT_TYPE` / `USER_CLIENT_ID`; new
  `user:disable` / `user:enable`; `user:list` shows type, client and disabled;
  `key:set` and `seed:admin` refuse client accounts.
- Tests: `test/account-types.e2e-spec.ts` (the portal matrix, the
  cross-portal refresh, disabling mid-session, re-scoping), additions to the
  token, service, contract, script and DB suites.
