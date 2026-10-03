import type { Request } from 'express';
import { Portal } from '../portal/portal';
import { RequestMeta } from './auth-event';

/**
 * The log's view of a request. `portal` was set by PortalGuard, which has
 * already refused the request if it could not be. `req.ip` is the client's
 * address only when TRUST_PROXY is set behind a proxy; otherwise it is the
 * proxy's, and every row records the same address.
 */
export function requestMeta(req: Request & { portal?: Portal }): RequestMeta {
  const userAgent = req.headers?.['user-agent'];
  return {
    portal: req.portal as Portal,
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}
