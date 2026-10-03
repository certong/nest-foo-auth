import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthEventInput, RequestMeta, fromMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { Portal } from '../portal/portal';
import { PrismaService } from '../prisma/prisma.service';
import { burnVerifyTime, verifyPassword } from './password';
import { ACCOUNT_PIN_ID } from './account-pin';
import { AccountType, canEnter, isAccountType, portalDenied } from './account-type';
import {
  KEY_MAX_ATTEMPTS,
  keyLocked,
  keyRejected,
  lockoutSeconds,
  remainingSeconds,
} from './key-lockout';
import { SessionClaims, signAccessToken, signRefreshToken, verifyToken } from './session-token';
import { TOKEN_KEYS, TokenKeys } from './token-keys';

/**
 * One message for both "no such email" and "wrong password". Two distinct
 * messages would turn the login form into an account lookup.
 */
export const INVALID_CREDENTIALS = 'Invalid email or password';

export { KEY_LOCKED, KEY_REJECTED } from './key-lockout';

/** The columns of an account row a session is built from. */
interface AccountRow {
  id: string;
  email: string;
  accountType: string;
  clientId: number | null;
  disabledAt: Date | null;
}

type SessionAccount = Omit<SessionClaims, 'sid'>;

/**
 * The account as a session sees it, or null if the row is not one a session may
 * start from: disabled, or holding an account_type the CHECK should have made
 * impossible. Null is treated exactly like a wrong password by every caller —
 * a disabled login must not be told apart from a mistyped one.
 */
function sessionAccount(row: AccountRow): SessionAccount | null {
  if (row.disabledAt !== null || !isAccountType(row.accountType)) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    accountType: row.accountType,
    clientId: row.accountType === 'client' ? row.clientId : null,
  };
}

/**
 * Sign-in, refresh and sign-out.
 *
 * Moved from nest-foo-billing with its security logic unchanged. What is new:
 * every sign-in mints a session id (`sid`), tokens are addressed to the portal
 * the request came from, and each outcome is written to auth_event.
 *
 * The log writes follow one rule: they never change what a request answers.
 * Each failure path writes its row and then throws exactly what it threw before
 * — so unknown-email and wrong-password still cost one Argon2 verify, one
 * insert and one identical 401 — and AuthEventService swallows its own errors.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TOKEN_KEYS) private readonly keys: TokenKeys,
    private readonly events: AuthEventService,
  ) {}

  async validateCredentials(email: string, password: string, meta: RequestMeta): Promise<SessionClaims> {
    const user = await this.prisma.account.findUnique({ where: { email } });

    if (user === null) {
      // Deliberately not an early return: without spending the same Argon2 time
      // a real verify costs, response timing distinguishes a known address from
      // an unknown one.
      await burnVerifyTime(password);
      // No account to name, and the typed email is deliberately not stored:
      // people type passwords into that field.
      await this.log([{ kind: 'login_failed', method: 'password', accountId: null, ...fromMeta(meta) }]);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // A disabled account fails exactly like a wrong password: same Argon2 cost
    // (the verify has already run), same row, same 401. Telling the two apart
    // would confirm the account exists to whoever is trying it.
    const account = (await verifyPassword(user.passwordHash, password)) ? sessionAccount(user) : null;
    if (account === null) {
      await this.log([{ kind: 'login_failed', method: 'password', accountId: user.id, ...fromMeta(meta) }]);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // After the password, never before: refusing a client at billing before
    // verifying would answer "this email is a client" to anyone who asks.
    await this.assertPortal(account, 'password', null, meta);

    // Signing in with the password clears any PIN lockout on this account's
    // door. The lockout exists to stop an *unauthenticated* caller guessing six
    // digits; proving the password is not that. Without this, the only way out
    // of a long backoff is shell access to a box that can reach the database.
    //
    // updateMany rather than update: it is a no-op when this account does not
    // hold the door, where update would throw on a row that does not match.
    await this.prisma.accountPin.updateMany({
      where: { id: ACCOUNT_PIN_ID, accountId: user.id },
      data: { failedAttempts: 0, lockoutCount: 0, lockedUntil: null },
    });

    return this.startSession(account, 'password', meta);
  }

  /**
   * The six-digit operator key (POST /auth/key).
   *
   * A PIN carries no identity — that is its whole premise — so it cannot pick
   * between accounts. The door is therefore a row of its own that *points at*
   * one account, and any number of accounts may exist alongside it. Everyone
   * signs in with a password; exactly one of them also has this.
   *
   * The lockout, not the key, is the security control: 10^6 combinations falls
   * to a script in minutes, five attempts per exponential backoff does not.
   */
  async validateKey(key: string, meta: RequestMeta): Promise<SessionClaims> {
    // upsert rather than findUnique, so the counters are never absent. A
    // rejection that cannot report attemptsRemaining is a shorter body than one
    // that can, and that difference is readable on the first request — see
    // keyRejected in key-lockout.ts.
    const door = await this.prisma.accountPin.upsert({
      where: { id: ACCOUNT_PIN_ID },
      create: { id: ACCOUNT_PIN_ID },
      update: {},
      include: { account: true },
    });

    const now = new Date();
    if (door.lockedUntil !== null) {
      const retryAfter = remainingSeconds(door.lockedUntil, now);
      // Before the key is verified, so a locked operator cannot buy their way
      // back in early with a correct guess and a locked attacker learns nothing
      // from one. Not logged: nothing was verified, and the lockout that caused
      // it already wrote key_locked.
      if (retryAfter > 0) {
        throw keyLocked(retryAfter);
      }
    }

    const operator = await this.resolveOperator(door, key);
    if (operator === null) {
      throw await this.recordKeyFailure(door, now, meta);
    }

    // key:set refuses to give the PIN to a client, so this only bites if the
    // database was edited by hand. Checked anyway: the rule lives in one table
    // and every door goes through it.
    await this.assertPortal(operator, 'pin', null, meta);

    await this.prisma.accountPin.update({
      where: { id: ACCOUNT_PIN_ID },
      data: { failedAttempts: 0, lockoutCount: 0, lockedUntil: null },
    });

    return this.startSession(operator, 'pin', meta);
  }

  /**
   * A new session: a fresh sid, plus the two rows that say it began — the
   * sign-in itself, and the first entry into the portal it began from (spec
   * 15.6), so "which portals did this session reach" is one query over
   * portal_entry. One insert for both.
   */
  private async startSession(
    account: SessionAccount,
    method: 'password' | 'pin',
    meta: RequestMeta,
  ): Promise<SessionClaims> {
    const claims: SessionClaims = { ...account, sid: randomUUID() };
    await this.log([
      { kind: 'login_success', method, accountId: claims.id, sid: claims.sid, ...fromMeta(meta) },
      { kind: 'portal_entry', accountId: claims.id, sid: claims.sid, ...fromMeta(meta) },
    ]);
    return claims;
  }

  /**
   * The account this key opens, or null if it opens nothing.
   *
   * A door with no key configured spends the same Argon2 time as a wrong one
   * and then fails, so it walks the identical counting and lockout path.
   * Returning early would make "is a PIN configured?" answerable with a
   * stopwatch, and skipping the counters would make it answerable by watching
   * the countdown stand still.
   *
   * `account` null is unreachable while the account_pin_pairing CHECK holds —
   * the key and the account it opens are written together or not at all — but
   * it is treated as "no key" rather than asserted away, so a corrupted row
   * fails closed instead of 500ing.
   */
  private async resolveOperator(
    door: { keyHash: string | null; account: AccountRow | null },
    key: string,
  ): Promise<SessionAccount | null> {
    if (door.keyHash === null || door.account === null) {
      await burnVerifyTime(key);
      return null;
    }
    // A disabled holder is a door that opens nothing — verified, counted and
    // locked exactly like a wrong key, so the countdown cannot reveal it.
    return (await verifyPassword(door.keyHash, key)) ? sessionAccount(door.account) : null;
  }

  /**
   * Refuses, with 403 and a portal_denied row, an account type the request's
   * portal does not admit (account-type.ts). Only ever called once the
   * credential has been verified.
   */
  private async assertPortal(
    account: { id: string; accountType: AccountType },
    method: 'password' | 'pin' | null,
    sid: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    if (canEnter(account.accountType, meta.portal)) {
      return;
    }
    await this.log([{ kind: 'portal_denied', method, accountId: account.id, sid, ...fromMeta(meta) }]);
    throw portalDenied();
  }

  /**
   * Counts the failure, locking if it was the last attempt, logs it, and
   * returns the exception to throw.
   *
   * Compare-and-swap rather than a bare increment. The bare version read
   * lockout_count, computed a duration from it, and wrote — so two fifth
   * failures arriving together both read zero, both wrote a sixty-second lock,
   * and advanced the exponent twice for one lockout actually served. Here the
   * update only applies if the row still holds the values this request read, so
   * exactly one concurrent writer wins and the loser re-reads instead of
   * stacking a second write on top.
   *
   * Not a transaction around read-then-write: that would hold a lock on one
   * globally hot row across an Argon2 verify, serialising every PIN attempt in
   * the deployment and making this endpoint trivial to stall.
   *
   * What this does NOT fix is attempt amplification — the lock check and the
   * verify both happen before any write, so N simultaneous requests still get N
   * guesses against a budget of five. Bounding that needs the per-IP throttle in
   * auth.module.ts, or a lock taken before the verify, which is the serialising
   * cure above.
   *
   * The event is key_locked only for the request whose write actually started
   * the lockout; a CAS loser cannot know whether it would have, so it records
   * key_failed. `accountId` is the door holder (null when no key is set) — the
   * log is internal, and which account was being guessed at is the useful fact.
   */
  private async recordKeyFailure(
    seen: { failedAttempts: number; lockoutCount: number; accountId: string | null },
    now: Date,
    meta: RequestMeta,
  ): Promise<Error> {
    const attempts = seen.failedAttempts + 1;
    const locks = attempts >= KEY_MAX_ATTEMPTS;

    const { count } = await this.prisma.accountPin.updateMany({
      // The read values are the guard: if anything moved underneath us, this
      // matches nothing and we fall through to the re-read below.
      where: {
        id: ACCOUNT_PIN_ID,
        failedAttempts: seen.failedAttempts,
        lockoutCount: seen.lockoutCount,
      },
      data: locks
        ? {
            // Zeroed, not left at the maximum: when the lock expires the
            // operator needs a full budget, or their first typo re-locks them
            // immediately on the next rung of the schedule.
            failedAttempts: 0,
            lockoutCount: seen.lockoutCount + 1,
            lockedUntil: new Date(now.getTime() + lockoutSeconds(seen.lockoutCount) * 1000),
          }
        : { failedAttempts: attempts },
    });

    const event: AuthEventInput = {
      kind: count > 0 && locks ? 'key_locked' : 'key_failed',
      method: 'pin',
      accountId: seen.accountId ?? null,
      ...fromMeta(meta),
    };
    await this.log([event]);

    if (count === 0) {
      // A concurrent request counted this attempt already. Report what the row
      // actually says rather than what this request expected, so two racing
      // failures cannot both claim the same remaining count.
      return keyRejected(await this.attemptsRemaining());
    }

    // Still a 401: this request was a wrong key. The 429 belongs to the *next*
    // request, which is the first one the lock actually refuses.
    return keyRejected(locks ? 0 : KEY_MAX_ATTEMPTS - attempts);
  }

  private async attemptsRemaining(): Promise<number> {
    const door = await this.prisma.accountPin.findUnique({
      where: { id: ACCOUNT_PIN_ID },
      select: { failedAttempts: true, lockedUntil: true },
    });
    if (door === null || door.lockedUntil !== null) {
      return 0;
    }
    return Math.max(0, KEY_MAX_ATTEMPTS - door.failedAttempts);
  }

  /**
   * AuthEventService already swallows its own failures; this catches again so
   * that holds even if a future change to it, or a test double, does not.
   * Whatever happens to the log, a sign-in answers exactly as it would without
   * one.
   */
  private async log(events: AuthEventInput[]): Promise<void> {
    try {
      await this.events.record(events);
    } catch {
      // Deliberately silent here: AuthEventService is where log failures are
      // reported.
    }
  }

  /** An access token for one portal. */
  async createAccessToken(claims: SessionClaims, portal: Portal): Promise<string> {
    return signAccessToken(claims, portal, this.keys);
  }

  /** The refresh token: addressed to this service, good at every portal. */
  async createRefreshToken(claims: SessionClaims): Promise<string> {
    return signRefreshToken(claims, this.keys);
  }

  /**
   * Exchanges a refresh token for its claims, and records that the session
   * reached the portal this request came from (CP-37, spec 7.2).
   *
   * One primary-key read of the account per refresh (account-types spec 7.2).
   * Billing's version read nothing here, reasoning that nothing in the token
   * could change without the password changing too. Disabling a login and
   * changing its type are exactly such changes: without this read a disabled
   * client keeps minting tokens for up to twelve hours. A token whose type or
   * client no longer matches the row is refused, which sends the user back to
   * sign in rather than quietly re-scoping a live session.
   *
   * Then the portal rule. This is the check that matters most: there is one
   * refresh cookie for every portal, so a client who signed in at studio
   * reaches here from the billing origin the moment the billing frontend tries
   * to refresh — and must get no billing token.
   *
   * The portal_entry insert runs on every refresh and is a no-op after the first
   * per (sid, portal) — that is the partial unique index's job. Because the
   * password is typed once, this first refresh from a portal is what "signed in
   * to that portal" means.
   *
   * Rejects an access token presented here, the same way the guard rejects a
   * refresh token presented there — one kind of token, one job. A rejected
   * refresh is not logged (spec 15.7).
   */
  async refresh(token: string | undefined, meta: RequestMeta): Promise<SessionClaims> {
    if (token === undefined || token.length === 0) {
      throw new UnauthorizedException();
    }
    const claims = await verifyToken(token, this.keys, 'refresh');
    if (claims === null) {
      throw new UnauthorizedException();
    }

    const row = await this.prisma.account.findUnique({
      where: { id: claims.id },
      select: { accountType: true, clientId: true, disabledAt: true },
    });
    if (
      row === null ||
      row.disabledAt !== null ||
      row.accountType !== claims.accountType ||
      (row.clientId ?? null) !== claims.clientId
    ) {
      throw new UnauthorizedException();
    }

    await this.assertPortal(claims, null, claims.sid, meta);
    await this.log([{ kind: 'portal_entry', accountId: claims.id, sid: claims.sid, ...fromMeta(meta) }]);
    return claims;
  }

  /**
   * Records a sign-out when the request carried a valid refresh cookie. Never
   * throws: signing out of a tab whose session has already expired must still
   * clear browser state, so the controller clears the cookie whatever this
   * finds.
   */
  async logout(token: string | undefined, meta: RequestMeta): Promise<void> {
    if (token === undefined || token.length === 0) {
      return;
    }
    const claims = await verifyToken(token, this.keys, 'refresh');
    if (claims === null) {
      return;
    }
    await this.log([{ kind: 'logout', accountId: claims.id, sid: claims.sid, ...fromMeta(meta) }]);
  }
}
