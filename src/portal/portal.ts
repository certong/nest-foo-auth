/**
 * The portals this service signs people in to. Each is both a value of `aud`
 * on an access token and a value of auth_event.portal (whose CHECK constraint
 * lists the same two — change both together).
 */
export const PORTALS = ['billing', 'studio'] as const;
export type Portal = (typeof PORTALS)[number];

export function isPortal(value: unknown): value is Portal {
  return typeof value === 'string' && (PORTALS as readonly string[]).includes(value);
}

/**
 * Parses AUTH_PORTAL_ORIGINS, e.g.
 *
 *   https://billing.example.com=billing,https://studio.example.com=studio
 *
 * into origin -> portal. The same map is the CORS allowlist, so this is the one
 * place a deployment says which browser origins may talk to it at all.
 *
 * Strict on purpose. A browser's Origin header is scheme://host[:port] with no
 * path and no trailing slash; an entry written any other way would never match
 * and would fail as a mysterious 403 in production, so it fails at boot here
 * instead.
 */
export function parsePortalOrigins(value: string | undefined): Map<string, Portal> {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('AUTH_PORTAL_ORIGINS must list at least one origin=portal pair');
  }

  const map = new Map<string, Portal>();
  for (const entry of entries) {
    const separator = entry.lastIndexOf('=');
    if (separator <= 0) {
      throw new Error(`AUTH_PORTAL_ORIGINS: "${entry}" is not origin=portal`);
    }
    const raw = entry.slice(0, separator).trim();
    const portal = entry.slice(separator + 1).trim();

    if (!isPortal(portal)) {
      throw new Error(`AUTH_PORTAL_ORIGINS: "${portal}" is not a portal (expected ${PORTALS.join(' or ')})`);
    }
    const origin = normaliseOrigin(raw);
    if (map.has(origin)) {
      throw new Error(`AUTH_PORTAL_ORIGINS: ${origin} is listed twice`);
    }
    map.set(origin, portal);
  }
  return map;
}

function normaliseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AUTH_PORTAL_ORIGINS: "${raw}" is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`AUTH_PORTAL_ORIGINS: "${raw}" must be http or https`);
  }
  // new URL lowercases the host and drops a default port; anything left over
  // beyond the origin (a path, a trailing slash, a query) means the entry was
  // not an origin.
  if (raw.replace(/\/+$/, '') !== raw || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`AUTH_PORTAL_ORIGINS: "${raw}" must be an origin only (no path or trailing slash)`);
  }
  return url.origin;
}
