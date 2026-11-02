# Handoff: email + PIN sign-in for Studio (from react-foo-studio)

**From:** Studio frontend (react-foo-studio, FS-70, FS-71, FS-87) · **Date:** 15 Oct 2026
**Asks for:** a per-account PIN login, and FA-23 (remember this device).

> **Status (28 Oct 2026):** Part A shipped as FA-24 (#20), at `POST /api/auth/pin`
> rather than the `/pin-login` named below. Part B, FA-23, is not built yet: no
> `cp_device`, no `account_device`, no `/auth/device*` routes.

## Summary

Studio's clients sign in with **email + a 6-digit PIN**, not a password. They can also tick
"Remember this device for 30 days". On a remembered device, the next visit shows **Welcome back**
and asks for the PIN only.

The frontend is built against the contract below. With `VITE_USE_MOCK_AUTH=true` it uses a built-in mock of the same contract.
Against this service it calls the endpoints below and nothing else.

## The gap: FA-23 assumes an endpoint that does not exist

FA-23 adds `rememberDevice` to `POST /api/auth/pin-login`. That endpoint is not in this repo.
What exists is `POST /api/auth/key`, and it cannot serve Studio:

| `POST /auth/key` today | Studio needs |
|---|---|
| One key per deployment (`account_pin` singleton, id 1) | One PIN per account |
| No email: the key alone picks the account | Email + PIN |
| Staff only (`setAccountPin` refuses clients) | Client accounts (Studio's main users), staff allowed too |
| Lockout on the singleton row | Lockout per account |

So there are two pieces of work. Part A is new and not ticketed yet; part B is FA-23.
Leave `/auth/key` and `account_pin` as they are; billing's operator still uses them.

## Part A: per-account PIN login (new ticket needed)

### Data

- Per-account PIN: `pin_hash` (Argon2id, same as `password_hash`), nullable. Put it on `account` or
  in a new 1:1 table; your call. It must stay separate from the operator `account_pin` singleton.
- Per-account lockout: `pin_failed_attempts`, `pin_lockout_count`, `pin_locked_until`. Use the
  existing schedule in `key-lockout.ts`: 5 failures, then a 60 s lock that doubles per lockout, capped at 1 h.
- **Display name** on `account` (`display_name`, nullable, e.g. "Mei Ling Tan"). Welcome back
  shows it before anyone is signed in, so Studio cannot fetch it from its own API. The short name ("Mei")
  and initials ("MT") are derived on the frontend.

### `POST /api/auth/pin-login`

```jsonc
// request
{ "email": "mei@kopilane.com", "pin": "482913", "rememberDevice": true }
```

- DTO: `email` normalised like `LoginDto` (trim, lowercase, `@IsEmail`, max 255). `pin` matches `^\d{6}$`.
  `rememberDevice` is an optional boolean. Use whitelist + forbidNonWhitelisted, as elsewhere.
- **200**: the same body as `/auth/login` (`{ accessToken, user }`) and the same `cp_refresh` cookie.
  `/auth/refresh`, `/me` and logout must not be able to tell which method was used.
  If `rememberDevice` is true, also set `cp_device` (see Part B).
- **400**: malformed body.
- **401**: `{ statusCode: 401, error: "Unauthorized", message: "Invalid email or PIN", attemptsRemaining: n }`.
  The response must be identical for an unknown email, an account with no PIN, a disabled account and a wrong PIN:
  same body shape, `attemptsRemaining` included, and similar timing.
  Count unknown emails against something keyed by the normalised email, so the countdown does not reveal whether an account exists.
- **403**: wrong portal. Same rule and same moment as password login: after the PIN is verified, no cookie set.
- **429**: `{ statusCode: 429, error: "Too Many Requests", message: "Too many attempts", retryAfter: seconds }`.
  The per-IP throttle's 429 must read the same (reuse `KeyThrottlerFilter`).
- `auth_event`: `login_success` / `login_failed` with `method = 'pin'` (already allowed by the CHECK).
  Add the account's lock event: either reuse `key_locked` or add `pin_locked` (that needs the CHECK changed).
  Never log the PIN or the typed email.

### Admin CLI

- `npm run pin:set -- <email> <6 digits>` sets an account's PIN. It also clears that account's lockout and revokes its remembered devices.
  It is the recovery path, like `key:set`. Allowed for client and staff accounts.
- `npm run pin:clear -- <email>`.
- `npm run user:add` accepts `--name "Mei Ling Tan"`. Also add a way to set the name on an existing account.
- `user:list` shows whether each account has a PIN, and its name.

## Part B: remember this device (FA-23)

FA-23's scope stands. These are the details the frontend relies on, plus two corrections.

- `cp_device`: httpOnly, `Secure` per `AUTH_COOKIE_SECURE`, SameSite as `AUTH_COOKIE_SAMESITE`,
  path `/api/auth`, 30 days. Store only the token's SHA-256 (`account_device.token_hash`).
- **`GET /api/auth/device`**
  - **200**: `{ "email": "mei@kopilane.com", "displayName": "Mei Ling Tan", "rememberedUntil": "2026-11-13T09:12:00.000Z" }`.
    `displayName` may be null; the frontend then shows the email.
  - **404**: no cookie, or the token is unknown, expired or revoked. If the cookie was present, clear it.
- **`POST /api/auth/device-unlock`** `{ "pin": "482913" }`, sent with the cookie
  - **200**: the same body and `cp_refresh` as login. Update `last_used_at`. Keep `expires_at` as it is:
    30 days from when the box was ticked, not a sliding window.
  - **401** with `attemptsRemaining`: wrong PIN. It shares the account's lockout with `pin-login`.
  - **404**: device not valid. The frontend falls back to the full Sign in screen.
  - **429** with `retryAfter`: same shape as above.
- **`POST /api/auth/device/forget`**: always **204**, revokes the row and clears `cp_device`. This is the "Not you?" link.
- **`POST /api/auth/logout` keeps `cp_device`.** Signing out from the top bar lands on Welcome back
  (FS-71: "Sign-out from top bar lands here"). Only "Not you?" forgets the device.
- Revoke every device of an account when its PIN is set or cleared, or the account is disabled.
- `auth_event`: `device_remembered`, `device_unlock`, `device_forgotten` (CHECK change).

### Corrections to FA-23 as written

1. FA-23 says a 429 returns `triesLeft`. Use the conventions this service already has instead:
   `attemptsRemaining` on 401 and `retryAfter` on 429. The frontend reads those names.
2. FA-23 says "5 tries per minute per IP and per account". Use the per-account backoff schedule from
   `key-lockout.ts`, with the per-IP throttle as a coarse ceiling on top, the same as `/auth/key`.

## What the frontend does with each answer

| Response | Studio shows |
|---|---|
| 401 + `attemptsRemaining: 4` | PIN boxes go red: "That PIN didn't match. 4 tries left." |
| 401 + `attemptsRemaining: 0`, or 429 + `retryAfter` | "Too many tries. Try again in N minutes, or ask Chi to reset your PIN." |
| 403 | "This account can't sign in to Studio. Ask Chi to set up Studio access." |
| 404 from `/device` or `/device-unlock` | Full Sign in screen (email + PIN) |

## Cookies and origins (unchanged)

The Studio origin (`http://localhost:5182` locally) must be in `AUTH_PORTAL_ORIGINS` as `=studio`.
Both cookies are SameSite=Lax, so locally everything must use `localhost`, never `127.0.0.1`.

## Done when

- [ ] A client with a PIN signs in to Studio with email + PIN; a wrong PIN counts down, then locks.
- [ ] An unknown email, a disabled account and a wrong PIN give identical 401s.
- [ ] Ticked "remember": after the 12 h refresh cookie expires, `GET /device` returns the name and email,
      and `device-unlock` with the PIN signs in.
- [ ] Not ticked: `GET /device` returns 404.
- [ ] Day 31: `device-unlock` returns 404.
- [ ] `pin:set` on an account makes every one of its remembered devices return 404.
- [ ] Logout keeps the device; `device/forget` removes it.
- [ ] No PIN, raw device token or typed email in any log or `auth_event` row.
- [ ] `/auth/key` and the billing operator's PIN behave exactly as before.
