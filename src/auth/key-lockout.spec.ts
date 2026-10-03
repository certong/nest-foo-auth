import { KEY_LOCKOUT_CAP_SECONDS, lockoutSeconds, remainingSeconds } from './key-lockout';

describe('lockoutSeconds', () => {
  it('locks the first offence for one minute', () => {
    // Called with the count of lockouts already served, which is zero the first
    // time the fifth failure arrives.
    expect(lockoutSeconds(0)).toBe(60);
  });

  it('doubles for each lockout already served', () => {
    expect(lockoutSeconds(1)).toBe(120);
    expect(lockoutSeconds(2)).toBe(240);
    expect(lockoutSeconds(3)).toBe(480);
    expect(lockoutSeconds(4)).toBe(960);
  });

  it('caps at one hour rather than doubling forever', () => {
    // 60 * 2^6 = 3840, the first value past the cap.
    expect(lockoutSeconds(6)).toBe(KEY_LOCKOUT_CAP_SECONDS);
    expect(lockoutSeconds(40)).toBe(KEY_LOCKOUT_CAP_SECONDS);
  });

  it('never overflows into Infinity for an absurd count', () => {
    expect(Number.isFinite(lockoutSeconds(2000))).toBe(true);
  });
});

describe('remainingSeconds', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');

  it('rounds a partial second up, so it never reports zero while still locked', () => {
    expect(remainingSeconds(new Date('2026-09-19T12:00:00.400Z'), now)).toBe(1);
  });

  it('reports the whole wait for a fresh lock', () => {
    expect(remainingSeconds(new Date('2026-09-19T12:02:00.000Z'), now)).toBe(120);
  });

  it('reports zero once the lock has expired', () => {
    expect(remainingSeconds(new Date('2026-09-19T11:59:00.000Z'), now)).toBe(0);
  });
});
