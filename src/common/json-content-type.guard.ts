import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The CSRF defence.
 *
 * Since CP-37 the access token is a bearer credential, so most endpoints are no
 * longer CSRF-able on their own — a cross-site form cannot attach it. What this
 * still protects is the refresh cookie, which is httpOnly and *is* sent
 * cross-site: without this, someone else's page could post to /auth/refresh and
 * mint a session. So the guard stays, and something has to distinguish our SPA
 * from a form on someone else's page. A cross-site form cannot set Content-Type:
 * application/json, and a cross-site fetch that does triggers a preflight that
 * the CORS origin allowlist rejects. PortalGuard, which runs before this one,
 * refuses an unknown Origin outright; the two are independent, so either alone
 * still stops a cross-site refresh.
 *
 * A guard rather than middleware: Nest 11 runs Express 5, which dropped bare '*'
 * route syntax, and an exception thrown here passes through Nest's exception
 * filter so the 415 body keeps the { message, error, statusCode } shape the
 * frontend already parses.
 *
 * Consequence worth knowing: DELETE requests must send the header too, even
 * though they carry no body. The frontend's apiFetch already sets it on every
 * request.
 */
/** Media type only, ignoring parameters such as `; charset=utf-8` or a
 * multipart boundary. */
function declaresMediaType(header: unknown, mediaType: string): boolean {
  if (typeof header !== 'string') {
    return false;
  }
  return header.split(';')[0].trim().toLowerCase() === mediaType;
}

function declaresJson(header: unknown): boolean {
  return declaresMediaType(header, 'application/json');
}

@Injectable()
export class JsonContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!MUTATING_METHODS.has(request.method)) {
      return true;
    }

    // Deliberately not request.is(): that helper reports false whenever the
    // request carries no body, so a bodyless POST /auth/logout or DELETE would be
    // rejected even though it declared JSON correctly. What matters here is only
    // what the caller declared, which is the part a cross-site form cannot fake.
    if (!declaresJson(request.headers['content-type'])) {
      throw new UnsupportedMediaTypeException('Content-Type must be application/json');
    }

    return true;
  }
}
