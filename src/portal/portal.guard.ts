import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NO_PORTAL_KEY } from './no-portal.decorator';
import { PortalOrigins } from './portal-origins';
import { Portal } from './portal';

export const ORIGIN_NOT_ALLOWED = 'Origin not allowed';

/**
 * Works out which portal a request is for, from its Origin header and nothing
 * else — never a body or query parameter, which the caller chooses freely.
 *
 * Registered first among the global guards, so a request from an unknown origin
 * is refused before any credential is looked at, any Argon2 time is spent, or
 * any throttle budget is used.
 *
 * CORS alone would not do this. CORS stops a browser *reading* a response; it
 * does not stop a non-browser client sending the request, nor a browser sending
 * a "simple" one. This is what actually refuses it. With JsonContentTypeGuard it
 * is also a second CSRF control on /auth/refresh, the one endpoint that
 * authenticates by cookie.
 *
 * 403, not 401 (spec 15.1). A missing or unknown origin is a deployment fault,
 * not a session state, and the frontend treats 401 as "sign in again".
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly origins: PortalOrigins,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const exempt = this.reflector.getAllAndOverride<boolean>(NO_PORTAL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
      portal?: Portal;
    }>();
    const portal = this.origins.portalFor(request.headers?.origin);
    if (portal === null) {
      throw new ForbiddenException(ORIGIN_NOT_ALLOWED);
    }
    request.portal = portal;
    return true;
  }
}
