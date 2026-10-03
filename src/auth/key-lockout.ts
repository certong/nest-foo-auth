import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

/**
 * The backoff arithmetic behind POST /auth/key, kept apart from the service so
 * the schedule can be read and tested without a database in the picture.
 *
 * A six-digit key is 10^6 combinations, which is not a secret worth much on its
 * own. This schedule is the actual security control: it makes the millionth
 * guess unreachable in any human timeframe, which the key's own entropy does not.
 */

/** Failures tolerated before the key locks. */
export const KEY_MAX_ATTEMPTS = 5;

/** The first lockout's length; every later one doubles from here. */
export const KEY_LOCKOUT_BASE_SECONDS = 60;

/**
 * One hour. Past this the doubling stops — an unbounded schedule would turn a
 * forgotten key into a permanent outage rather than a long inconvenience, and
 * an hour per five guesses is already far below any useful search rate.
 */
export const KEY_LOCKOUT_CAP_SECONDS = 3600;

/**
 * How long to lock, given the number of lockouts *already served* — so the first
 * lockout is computed from zero and lasts the base minute.
 *
 * The exponent is clamped rather than trusted: `2 ** 2000` is Infinity, and an
 * Infinity here would be written to a DateTime column as an Invalid Date.
 */
export function lockoutSeconds(lockoutsServed: number): number {
  const exponent = Math.min(Math.max(lockoutsServed, 0), MAX_DOUBLINGS);
  return Math.min(KEY_LOCKOUT_BASE_SECONDS * 2 ** exponent, KEY_LOCKOUT_CAP_SECONDS);
}

/** Doublings before the cap bites: 60s * 2^6 = 3840, the first value past an hour. */
const MAX_DOUBLINGS = Math.ceil(Math.log2(KEY_LOCKOUT_CAP_SECONDS / KEY_LOCKOUT_BASE_SECONDS));

/**
 * Seconds until `lockedUntil`, rounded up and floored at zero.
 *
 * Rounding up matters: reporting `0` to a caller that is still locked would have
 * the screen invite an immediate retry that can only 429 again.
 */
export function remainingSeconds(lockedUntil: Date, now: Date): number {
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

/**
 * One message for a wrong key, a key that is not configured, and a deployment
 * with more than one `account` row. The mirror of INVALID_CREDENTIALS: two
 * distinct messages would turn this endpoint into a configuration probe.
 */
export const KEY_REJECTED = 'Invalid key';

/** Shared by the lockout and by the coarse throttle, so neither names itself. */
export const KEY_LOCKED = 'Too many attempts';

/**
 * 401 for a rejected key.
 *
 * `attemptsRemaining` is required, deliberately. An earlier version made it
 * optional and omitted it wherever there was no counter to read from, which
 * meant a misconfigured deployment answered with a shorter body than a wrong
 * key and was therefore distinguishable on the very first request — no
 * countdown needed. Making the parameter mandatory is what stops that
 * reappearing: there is no longer a way to spell the short body.
 *
 * The counter is now always readable, because validateKey upserts the singleton
 * rather than looking it up. See AccountPin in schema.prisma.
 */
export function keyRejected(attemptsRemaining: number): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: HttpStatus.UNAUTHORIZED,
    error: 'Unauthorized',
    message: KEY_REJECTED,
    attemptsRemaining,
  });
}

/**
 * 429 for a locked key. This is the shape the throttle's own 429 is rewritten
 * into by KeyThrottlerFilter, so the caller cannot tell which limit fired.
 */
export function keyLocked(retryAfter: number): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: KEY_LOCKED,
      retryAfter,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
