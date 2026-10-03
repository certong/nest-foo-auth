import { SetMetadata } from '@nestjs/common';

export const NO_PORTAL_KEY = 'noPortal';

/**
 * Exempts a route from PortalGuard. Only for routes fetched server-to-server,
 * which carry no Origin: the JWKS and the health check. Anything a browser
 * calls must have a portal.
 */
export const NoPortal = (): MethodDecorator & ClassDecorator => SetMetadata(NO_PORTAL_KEY, true);
