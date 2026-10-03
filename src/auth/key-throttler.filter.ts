import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { KEY_LOCKED } from './key-lockout';

/**
 * Fallback wait when the guard set no Retry-After header, in seconds. Matches
 * the `login` throttler's ttl, which is the longest a throttled caller can
 * actually be asked to wait.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 900;

/**
 * Makes the coarse per-IP throttle's 429 indistinguishable from the operator
 * lockout's 429 (CP handoff, decision 2).
 *
 * Two reasons this filter exists rather than nothing:
 *
 * A raw ThrottlerException's body carries no `retryAfter`, and the login screen
 * renders its "try again in N" countdown from that field — throttled callers
 * would get a bare "locked" with no idea for how long.
 *
 * And the two 429s must read alike. The throttle is the outer bound that keeps
 * an unkeyed deployment from being made to burn Argon2 time indefinitely — that
 * path has no row to lock, so the lockout cannot bound it — but which limit
 * fired is not the caller's business, because it says whether the operator's
 * five attempts are already spent.
 */
/**
 * ThrottlerGuard sets Retry-After before it throws, which is the real remaining
 * window rather than a restatement of the configured ttl — but a *named*
 * throttler suffixes the header with its name, and ours is named 'login', so the
 * header arrives as `Retry-After-login`. Matching on the prefix keeps this
 * working whether or not the throttler keeps its name.
 */
function headerSeconds(response: Response): number | null {
  for (const [name, value] of Object.entries(response.getHeaders())) {
    if (!name.toLowerCase().startsWith('retry-after')) {
      continue;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  }
  return null;
}

@Catch(ThrottlerException)
export class KeyThrottlerFilter implements ExceptionFilter {
  catch(_exception: ThrottlerException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    const retryAfter = headerSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;

    response.status(HttpStatus.TOO_MANY_REQUESTS).json({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: KEY_LOCKED,
      retryAfter,
    });
  }
}
