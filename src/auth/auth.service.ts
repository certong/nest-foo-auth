import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthEventInput, RequestMeta, fromMeta } from '../events/auth-event';
import { AuthEventService } from '../events/auth-event.service';
import { Portal } from '../portal/portal';
import { PrismaService } from '../prisma/prisma.service';
import { burnVerifyTime, verifyPassword } from './password';
import { AccountType, canEnter, isAccountType, portalDenied } from './account-type';
import { PinLockout, pinLocked, pinRejected } from './pin-lockout';
import { SessionClaims, signAccessToken, signRefreshToken, verifyToken } from './session-token';
import { TOKEN_KEYS, TokenKeys } from './token-keys';

/**
 * One message for both "no such email" and "wrong password". Two distinct
 * messages would turn the login form into an account lookup.
 */
export const INVALID_CREDENTIALS = 'Invalid email or password';

/**
 * Studio takes the PIN only (FA-24). 403, not 401: the frontend reads 401 as
 * "wrong password", and nothing typed was wrong — only the way in.
 */
export const USE_PIN_SIGN_IN = 'Use PIN sign-in for this portal';

export { PIN_LOCKED, PIN_REJECTED } from './pin-lockout';

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
    private readonly pinLockout: PinLockout,
  ) {}

  /**
   * Email and six-digit PIN (POST /auth/pin, FA-24). Each account holds its own
   * PIN (auth.account_pin), created by `npm run key:set`.
   *
   * The email is optional from billing (FA-25): that portal is staff-only and
   * single-operator, so `billingOperatorEmail` resolves whose PIN it must be
   * and everything below is unchanged. Studio must still send one — a PIN there
   * names nobody. The resolution happens BEFORE the lockout is taken, so the
   * attempt is still counted against an account rather than against a portal,
   * and the budget logic below never learns the difference.
   *
   * An unknown email, an account with no PIN, a disabled account and a wrong
   * PIN all cost one Argon2 verify, count against the typed email's lockout,
   * and get the same 401 body. Any difference between them would tell a caller
   * which emails have accounts.
   *
   * The lockout, not the PIN, is the security control: 10^6 combinations falls
   * to a script in minutes, five tries per fifteen minutes does not.
   */
  async validatePin(email: string | undefined, pin: string, meta: RequestMeta): Promise<SessionClaims> {
    const resolved = email ?? (await this.billingOperatorEmail(meta));
    const attempt = this.pinLockout.take(resolved);
    if (attempt.locked) {
      // Before the PIN is verified, so a locked caller cannot buy their way back
      // in early with a correct guess and learns nothing from one. Not logged:
      // nothing was verified, and the attempt that started the lock already
      // wrote key_locked.
      throw pinLocked(attempt.retryAfter);
    }

    const user = await this.prisma.account.findUnique({ where: { email: resolved }, include: { pin: true } });
    let account: SessionAccount | null = null;
    if (user === null || user.pin === null) {
      await burnVerifyTime(pin);
    } else if (await verifyPassword(user.pin.pinHash, pin)) {
      // A disabled account is a PIN that opens nothing: verified, counted and
      // locked exactly like a wrong one.
      account = sessionAccount(user);
    }

    if (account === null) {
      // The account is named when there is one — the log is internal, and which
      // account was being guessed at is the useful fact. Never the typed email.
      await this.log([
        {
          kind: attempt.locks ? 'key_locked' : 'key_failed',
          method: 'pin',
          accountId: user?.id ?? null,
          ...fromMeta(meta),
        },
      ]);
      // Still a 401 when this attempt started the lock: it was a wrong PIN. The
      // 429 belongs to the next request, the first one the lock refuses.
      throw pinRejected(attempt.attemptsRemaining);
    }

    // The PIN was right, so the attempt taken above is given back — before the
    // portal check, which refuses a right PIN rather than a wrong one.
    this.pinLockout.clear(resolved);
    await this.assertPortal(account, 'pin', null, meta);
    return this.startSession(account, 'pin', meta);
  }

  /**
   * Whose PIN a billing request without an email is offering (FA-25).
   *
   * Billing is staff-only and single-operator, so there is one account its PIN
   * could belong to and the portal does not need to ask its operator to type an
   * address before six digits. Studio is not: several people hold accounts
   * there, a PIN alone names none of them, and a request from that portal with
   * no email is refused here rather than guessed at.
   *
   * Resolved by LOOKUP, not by trying the PIN against every staff account. A
   * search would cost one Argon2 verify per account and would have no defined
   * answer when two of them chose the same six digits.
   *
   * Zero matches, or more than one, is refused exactly as a wrong PIN is —
   * same 401, same shape — so this never becomes a way to ask how many staff
   * accounts exist. More than one is the case worth knowing about: billing's
   * single-operator assumption has stopped holding and this door should be
   * reconsidered rather than silently picking a human. The lockout is not
   * touched on that path; nothing was typed wrongly.
   */
  private async billingOperatorEmail(meta: RequestMeta): Promise<string> {
    if (meta.portal === 'billing') {
      const operators = await this.prisma.account.findMany({
        where: { accountType: 'staff', disabledAt: null, pin: { isNot: null } },
        select: { email: true },
        // Two is all it takes to know the assumption is broken; there is no
        // reason to read the rest.
        take: 2,
      });
      if (operators.length === 1) {
        return operators[0]!.email;
      }
    }

    // Nothing to verify against: studio sent no email, or billing has no single
    // operator to attribute the PIN to. Both answer exactly as a wrong PIN
    // does, down to `attemptsRemaining` — `pinRejected` requires that field so
    // every rejection has one shape, and a body that lacked it here would make
    // this path readable on the first request.
    //
    // The count comes from a real attempt against a key of the portal's own, so
    // the answer is honest and the path cannot be hammered. It is a separate
    // key from any account's: a caller who cannot name an account must not be
    // able to spend the operator's five tries and lock them out.
    const attempt = this.pinLockout.take(`portal:${meta.portal}`);
    if (attempt.locked) {
      throw pinLocked(attempt.retryAfter);
    }
    await this.log([
      { kind: attempt.locks ? 'key_locked' : 'key_failed', method: 'pin', accountId: null, ...fromMeta(meta) },
    ]);
    // The same Argon2 time a real verify costs. Without it, "no operator
    // resolved" returns measurably faster than a wrong PIN.
    await burnVerifyTime('000000');
    throw pinRejected(attempt.attemptsRemaining);
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
