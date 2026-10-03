import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { REFRESH_TOKEN_TTL_SECONDS } from './session-token';

/**
 * The refresh token's cookie (CP-37).
 *
 * The access token is a bearer credential the frontend holds and attaches; this
 * one deliberately is not. It lives longer, so it stays somewhere JavaScript
 * cannot read it — an injected script can steal fifteen minutes of access, not
 * the ability to mint more for twelve hours.
 */
export const REFRESH_COOKIE_NAME = 'cp_refresh';

const SAME_SITE_VALUES = ['lax', 'strict', 'none'] as const;
type SameSite = (typeof SAME_SITE_VALUES)[number];

export interface CookieConfig {
  secure: boolean;
  sameSite: SameSite;
}

/**
 * Driven by environment rather than a NODE_ENV branch, so the deployed posture is
 * inspectable. The default is the development one: same-site, no TLS.
 */
export function readCookieConfig(config: ConfigService): CookieConfig {
  const sameSite = (config.get<string>('AUTH_COOKIE_SAMESITE') ?? 'lax').toLowerCase();
  if (!SAME_SITE_VALUES.includes(sameSite as SameSite)) {
    throw new Error(`AUTH_COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')}`);
  }

  const secure = config.get<string>('AUTH_COOKIE_SECURE') === 'true';

  // Browsers discard a SameSite=None cookie that is not also Secure, and they do
  // it without an error anyone will see. Failing at boot beats debugging a login
  // that appears to succeed and then 401s on every subsequent request.
  if (sameSite === 'none' && !secure) {
    throw new Error('AUTH_COOKIE_SAMESITE=none requires AUTH_COOKIE_SECURE=true');
  }

  return { secure, sameSite: sameSite as SameSite };
}

/**
 * Scoped to the refresh route: the browser sends this cookie only when asking
 * for a new access token, so it is not attached to ordinary API traffic and
 * cannot be used as an ambient credential the way the old session cookie was.
 * No `domain` — a host-only cookie is what we want.
 */
function baseOptions(cfg: CookieConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    path: '/api/auth',
  };
}

export function setRefreshCookie(res: Response, token: string, cfg: CookieConfig): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseOptions(cfg),
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

/**
 * Must mirror setRefreshCookie's attributes exactly or the browser keeps the
 * cookie and sign-out does nothing.
 */
export function clearRefreshCookie(res: Response, cfg: CookieConfig): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions(cfg));
}
