import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Ten minutes (CP-43). Long enough that a session on one screen preflights
 * once rather than once per request, short enough that a change to the policy
 * takes effect the same day. Browsers cap it anyway — Chrome at 2 hours,
 * Firefox at 24 — so a larger number would only be aspirational.
 */
export const DEFAULT_CORS_MAX_AGE_SECONDS = 600;

/**
 * The whole CORS policy, as a value.
 *
 * Built here rather than inline in bootstrap() so a suite can read it:
 * loosening an origin allowlist is a security change, and nothing would catch
 * it otherwise.
 *
 * The allowlist is the key set of AUTH_PORTAL_ORIGINS (see PortalOrigins). There
 * is no fallback origin, unlike billing's: that map is required at boot, so an
 * empty allowlist cannot reach here.
 */
export function corsOptions(origins: string[], maxAge?: string | number): CorsOptions {
  return {
    origin: [...origins],
    // The refresh cookie rides on login, refresh and logout.
    credentials: true,
    // Every route here is GET or POST.
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // CP-43. Without this the browser cannot cache the preflight and sends an
    // OPTIONS before every single request. Every call to this service is
    // cross-origin — each frontend lives on its own host — so it always bites.
    maxAge: positiveSeconds(maxAge) ?? DEFAULT_CORS_MAX_AGE_SECONDS,
  };
}

/** Null for anything that is not a positive number of seconds, so a typo in the
 * environment falls back to the default instead of disabling the cache. */
function positiveSeconds(value: string | number | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
