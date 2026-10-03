import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Portal, parsePortalOrigins } from './portal';

/**
 * AUTH_PORTAL_ORIGINS, parsed once at construction so a bad value fails at
 * boot. One map serves two purposes: which portal a request is for, and the
 * CORS allowlist — so an origin cannot be allowed by CORS without also being
 * assigned a portal, or the reverse.
 */
@Injectable()
export class PortalOrigins {
  private readonly map: Map<string, Portal>;

  constructor(config: ConfigService) {
    this.map = parsePortalOrigins(config.get<string>('AUTH_PORTAL_ORIGINS'));
  }

  /**
   * The portal for an Origin header value, or null. Exact match only: the
   * browser sends the origin verbatim, and anything looser (prefix, suffix,
   * case-folding the scheme) is how allowlists get bypassed.
   */
  portalFor(origin: unknown): Portal | null {
    return typeof origin === 'string' ? (this.map.get(origin) ?? null) : null;
  }

  origins(): string[] {
    return [...this.map.keys()];
  }
}
