import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  readCookieConfig,
  setRefreshCookie,
} from './session-cookie';

function configOf(values: Record<string, string | undefined>): ConfigService {
  return new ConfigService(values);
}

/** Captures what was handed to res.cookie / res.clearCookie. */
function responseSpy() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  return { spy: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
}

describe('readCookieConfig', () => {
  it('defaults to the same-site development posture', () => {
    expect(readCookieConfig(configOf({}))).toEqual({ secure: false, sameSite: 'lax' });
  });

  it('reads the production posture from the environment', () => {
    expect(
      readCookieConfig(configOf({ AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAMESITE: 'none' })),
    ).toEqual({ secure: true, sameSite: 'none' });
  });

  it('rejects SameSite=None without Secure, which every browser silently drops', () => {
    expect(() =>
      readCookieConfig(configOf({ AUTH_COOKIE_SECURE: 'false', AUTH_COOKIE_SAMESITE: 'none' })),
    ).toThrow(/AUTH_COOKIE_SECURE/);
  });

  it('rejects an unrecognised SameSite value rather than guessing', () => {
    expect(() => readCookieConfig(configOf({ AUTH_COOKIE_SAMESITE: 'sometimes' }))).toThrow(
      /AUTH_COOKIE_SAMESITE/,
    );
  });
});

describe('refresh cookie', () => {
  const cfg = { secure: true, sameSite: 'none' } as const;

  it('sets an httpOnly cookie that expires in twelve hours', () => {
    const { spy, cookie } = responseSpy();
    setRefreshCookie(spy, 'the-token', cfg);
    expect(cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'the-token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      // Scoped to the auth routes: the browser attaches this only when asking
      // for a new access token, so it is never an ambient credential on
      // ordinary API traffic.
      path: '/api/auth',
      maxAge: 43_200_000,
    });
  });

  it('sets no domain, keeping the cookie host-only', () => {
    const { spy, cookie } = responseSpy();
    setRefreshCookie(spy, 'the-token', cfg);
    // Widening to the parent domain would hand the session to every sibling
    // subdomain.
    expect(cookie.mock.calls[0][2]).not.toHaveProperty('domain');
  });

  it('clears with the same attributes it set, minus maxAge', () => {
    const { spy, clearCookie } = responseSpy();
    clearRefreshCookie(spy, cfg);
    // A mismatch on any of path, sameSite or secure leaves the cookie in place
    // and sign-out silently does nothing.
    expect(clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/api/auth',
    });
  });
});
