import { PIN_LOCKOUT_SECONDS, PIN_MAX_ATTEMPTS, PinLockout } from './pin-lockout';

const EMAIL = 'admin@example.com';
const T0 = 1_700_000_000_000;
const WINDOW_MS = PIN_LOCKOUT_SECONDS * 1000;

function failFiveTimes(lockout: PinLockout, email = EMAIL, now = T0) {
  return Array.from({ length: PIN_MAX_ATTEMPTS }, () => lockout.take(email, now));
}

describe('PinLockout', () => {
  it('counts down 4,3,2,1,0 and then locks for fifteen minutes', () => {
    const lockout = new PinLockout();

    const seen = failFiveTimes(lockout).map((a) => (a.locked ? 'locked' : a.attemptsRemaining));

    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(lockout.take(EMAIL, T0)).toEqual({ locked: true, retryAfter: PIN_LOCKOUT_SECONDS });
  });

  it('flags the attempt that starts the lock, and only that one', () => {
    const lockout = new PinLockout();
    const locks = failFiveTimes(lockout).map((a) => !a.locked && a.locks);
    expect(locks).toEqual([false, false, false, false, true]);
  });

  it('reports the seconds left, rounded up', () => {
    const lockout = new PinLockout();
    failFiveTimes(lockout);

    expect(lockout.take(EMAIL, T0 + WINDOW_MS - 1500)).toEqual({ locked: true, retryAfter: 2 });
  });

  it('does not spend an attempt or extend the lock while locked', () => {
    const lockout = new PinLockout();
    failFiveTimes(lockout);
    lockout.take(EMAIL, T0 + 1000);
    lockout.take(EMAIL, T0 + 2000);

    // Still ends at the original time, with a full budget after it.
    expect(lockout.take(EMAIL, T0 + WINDOW_MS)).toMatchObject({ locked: false, attemptsRemaining: 4 });
  });

  it('counts each email on its own', () => {
    const lockout = new PinLockout();
    failFiveTimes(lockout);

    expect(lockout.take('someone-else@example.com', T0)).toMatchObject({ locked: false, attemptsRemaining: 4 });
  });

  it('locks an email with no account exactly like a real one', () => {
    // It never looks anything up: an email is an email.
    const lockout = new PinLockout();
    const seen = failFiveTimes(lockout, 'nobody@example.com').map((a) => !a.locked && a.attemptsRemaining);

    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(lockout.take('nobody@example.com', T0).locked).toBe(true);
  });

  it('forgets failures older than the window', () => {
    const lockout = new PinLockout();
    lockout.take(EMAIL, T0);
    lockout.take(EMAIL, T0);

    expect(lockout.take(EMAIL, T0 + WINDOW_MS)).toMatchObject({ attemptsRemaining: 4 });
  });

  it('clear() hands back the full budget, even mid-lock', () => {
    const lockout = new PinLockout();
    failFiveTimes(lockout);
    lockout.clear(EMAIL);

    expect(lockout.take(EMAIL, T0)).toMatchObject({ locked: false, attemptsRemaining: 4 });
  });

  it('refuses the sixth of six requests taken together', () => {
    // The count is spent before the verify, so attempts sent at once cannot
    // all slip past the check before any of them is counted.
    const lockout = new PinLockout();
    const sixth = [...failFiveTimes(lockout), lockout.take(EMAIL, T0)].at(-1);
    expect(sixth?.locked).toBe(true);
  });

  it('sweeps expired entries once the map grows large', () => {
    const lockout = new PinLockout();
    for (let i = 0; i < 10_000; i += 1) {
      lockout.take(`user${i}@example.com`, T0);
    }
    lockout.take(EMAIL, T0 + WINDOW_MS);

    const size = (lockout as unknown as { entries: Map<string, unknown> }).entries.size;
    expect(size).toBe(1);
  });
});
