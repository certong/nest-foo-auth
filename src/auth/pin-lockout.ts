import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * The lockout behind POST /auth/pin (FA-24): five wrong tries lock the typed
 * email for fifteen minutes.
 *
 * Keyed by the email as typed, not by account, so an address with no account
 * counts down and locks exactly like a real one. Keying by account would leave
 * unknown emails unlimited, and "does this one ever lock?" would then answer
 * "does this account exist?".
 *
 * In memory, by decision: a restart or deploy clears every lock, and each
 * running instance keeps its own count. The per-IP `login` throttle in
 * auth.module.ts is the outer bound on both.
 */

/** Wrong tries before the email locks. */
export const PIN_MAX_ATTEMPTS = 5;

/** How long a lock lasts, and how long a run of failures is remembered. */
export const PIN_LOCKOUT_SECONDS = 15 * 60;

/** Entries are swept for expiry only once the map grows past this. */
const SWEEP_THRESHOLD = 10_000;

/**
 * One message for an unknown email, an account with no PIN, a disabled account
 * and a wrong PIN. Two messages would turn this endpoint into an account lookup.
 */
export const PIN_REJECTED = 'Invalid email or PIN';

/** Shared by the lockout and by the coarse throttle, so neither names itself. */
export const PIN_LOCKED = 'Too many attempts';

/**
 * 401 for a rejected PIN. `attemptsRemaining` is required so every rejection has
 * the same shape — a body that sometimes lacked it would be readable on the
 * first request.
 */
export function pinRejected(attemptsRemaining: number): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: HttpStatus.UNAUTHORIZED,
    error: 'Unauthorized',
    message: PIN_REJECTED,
    attemptsRemaining,
  });
}

/**
 * 429 for a locked email. PinThrottlerFilter rewrites the throttle's own 429
 * into this shape, so the caller cannot tell which limit fired.
 */
export function pinLocked(retryAfter: number): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: PIN_LOCKED,
      retryAfter,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** What `take` hands back: either the lock in force, or an attempt to spend. */
export type PinAttempt =
  | { locked: true; retryAfter: number }
  | {
      locked: false;
      /** What to report if this attempt turns out wrong. */
      attemptsRemaining: number;
      /** True when this attempt was the last one, and so started the lock. */
      locks: boolean;
    };

interface Entry {
  failures: number;
  /** When the current run of failures began; it is forgotten after the lockout window. */
  since: number;
  lockedUntil: number | null;
}

@Injectable()
export class PinLockout {
  private readonly entries = new Map<string, Entry>();

  /**
   * Spends one attempt for `email`, before the PIN is verified, or reports the
   * lock in force.
   *
   * Counting first is the point. If the count waited for the verify, N requests
   * sent together would all pass the lock check before any of them was
   * counted, and get N guesses against a budget of five. Here the sixth
   * concurrent request already sees the lock. A right PIN gives the attempt
   * back through `clear`.
   */
  take(email: string, now: number = Date.now()): PinAttempt {
    this.sweep(now);

    let entry = this.entries.get(email);
    if (entry?.lockedUntil != null && entry.lockedUntil > now) {
      return { locked: true, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    if (entry === undefined || this.expired(entry, now)) {
      entry = { failures: 0, since: now, lockedUntil: null };
      this.entries.set(email, entry);
    }

    entry.failures += 1;
    const locks = entry.failures >= PIN_MAX_ATTEMPTS;
    if (locks) {
      entry.lockedUntil = now + PIN_LOCKOUT_SECONDS * 1000;
    }
    return { locked: false, attemptsRemaining: Math.max(0, PIN_MAX_ATTEMPTS - entry.failures), locks };
  }

  /** Forgets every failure for `email`: a right PIN, or a right password. */
  clear(email: string): void {
    this.entries.delete(email);
  }

  /** A lock that has ended, or a run of failures older than the window. */
  private expired(entry: Entry, now: number): boolean {
    if (entry.lockedUntil !== null) {
      return entry.lockedUntil <= now;
    }
    return now - entry.since >= PIN_LOCKOUT_SECONDS * 1000;
  }

  /**
   * Drops expired entries once the map is large. Every typed email gets an
   * entry, unknown ones included, so without this the map grows with whatever
   * a caller cares to type.
   */
  private sweep(now: number): void {
    if (this.entries.size < SWEEP_THRESHOLD) {
      return;
    }
    for (const [email, entry] of this.entries) {
      if (this.expired(entry, now)) {
        this.entries.delete(email);
      }
    }
  }
}
