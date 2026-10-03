import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Portal } from '../portal/portal';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AuthenticatedUser, toAuthenticatedUser } from './authenticated-user';
import { SessionClaims, verifyToken } from './session-token';
import { TOKEN_KEYS, TokenKeys } from './token-keys';

const BEARER_PREFIX = 'Bearer ';

/**
 * Validates the access token on every non-public route — here, only GET /me.
 *
 * This reads the Authorization header and nothing else. A bearer token must be
 * readable by the script that sends it; the mitigation is the token's
 * fifteen-minute life — the long-lived half of the session stays in a cookie
 * this guard never looks at.
 *
 * There is exactly one credential path. A cookie is not accepted here, so the
 * refresh token cannot be replayed as ambient authority, and there is nothing
 * for a cross-site request to attach implicitly.
 *
 * The token's audience must be the portal this request came from (PortalGuard
 * runs first and sets it) — the same rule billing and studio enforce, so a
 * token one portal received is not a credential here on the other's behalf.
 *
 * Billing's DISABLE_AUTH escape hatch is deliberately absent: an issuer with an
 * authentication bypass has no use for one.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_KEYS) private readonly keys: TokenKeys,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
      portal?: Portal;
      user?: AuthenticatedUser;
    }>();

    const claims = await this.readClaims(request.headers?.authorization, request.portal);
    if (claims === null) {
      // A missing header, a malformed one, an expired token, a bad signature, a
      // foreign issuer, another portal's token and a refresh token presented as
      // an access token are all the same answer: 401, never 403, and never a
      // hint about which it was. Saying "expired" rather than "invalid" tells an
      // attacker which half of the problem to work on. The frontend treats 401
      // as "sign in again"; a 403 would strand it in a broken session.
      throw new UnauthorizedException();
    }

    // The /me shape: never the sid; clientId only for a client login.
    request.user = toAuthenticatedUser(claims);
    return true;
  }

  private async readClaims(header: unknown, portal: Portal | undefined): Promise<SessionClaims | null> {
    if (portal === undefined) {
      // Only a @NoPortal() route lacks one, and none of those is guarded.
      return null;
    }
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      return null;
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) {
      return null;
    }
    return verifyToken(token, this.keys, 'access', portal);
  }
}
