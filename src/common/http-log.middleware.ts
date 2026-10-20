import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import type { Portal } from '../portal/portal';

/**
 * One line per request, for local work. Ported from nest-foo-billing's
 * middleware of the same name (CP-109), with one deliberate difference: this
 * service never prints a body VALUE. See formatBodyKeys below.
 *
 * Without it a 401 from JwtAuthGuard, a 403 from PortalGuard, a 400 from the
 * ValidationPipe and a 200 all look the same from the terminal: silence. Those
 * four are most of what goes wrong here, and three of them answer deliberately
 * alike so a caller cannot learn from them -- which leaves the terminal as the
 * only place the difference is visible.
 *
 * Middleware rather than an interceptor, and that is the point: an interceptor
 * runs inside the Nest pipeline, after the guards, so it never sees the 403 or
 * the 401. Middleware runs before both and still reads the status on finish.
 *
 * Off unless APP_ENV is `local`, which is the value .env.example ships and the
 * boot banner prints. No new variable to forget, and no deployed environment
 * can acquire this by someone leaving a flag set.
 */
@Injectable()
export class HttpLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Http');
  private readonly enabled: boolean;

  constructor(configService: ConfigService) {
    this.enabled = configService.get<string>('APP_ENV') === 'local';
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (!this.enabled) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    // Read now, not on finish: the global ValidationPipe transforms req.body in
    // place, so by then it is the DTO instance rather than what the caller
    // actually sent -- and what they sent is the thing in question when a
    // request is being rejected.
    const keys = formatBodyKeys(req);

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const tagged = req as Request & { user?: AuthenticatedUser; portal?: Portal };

      // portal is set by PortalGuard from the Origin header, user by
      // JwtAuthGuard from the verified token. Both `-` means neither guard got
      // that far, which is what a 403 on the origin rule looks like.
      this.logger.log(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms ` +
          `portal=${tagged.portal ?? '-'} user=${tagged.user ? tagged.user.id.slice(0, 8) : '-'}`,
      );

      if (keys !== null) {
        this.logger.log(`  body keys: ${keys}`);
      }
    });

    next();
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Enough to see the shape; a body with more keys than this is not ours. */
const KEY_LIMIT = 12;

/**
 * The body's KEY NAMES, never its values, and never a count of anything else.
 *
 * Billing redacts a list of sensitive key names and prints the rest, which
 * suits it: its bodies are invoices and payments, and the values are the point.
 * Here every value in every body is a credential -- `pin`, `password`, and
 * `email`, which this service deliberately never records anywhere because
 * people type passwords into that field (see AuthEventService). Redacting them
 * all would leave `{"email":"[redacted]","pin":"[redacted]"}`, which is a line
 * that costs a risk and says nothing.
 *
 * The keys alone are the diagnostic that matters. A 400 on /auth/pin is almost
 * always the wrong shape -- an email sent that should have been omitted, or
 * omitted when studio needed it -- and `body keys: pin` against
 * `body keys: email, pin` says which, while carrying nothing worth leaking.
 */
export function formatBodyKeys(req: Request): string | null {
  if (!MUTATING_METHODS.has(req.method)) {
    return null;
  }

  const body: unknown = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const keys = Object.keys(body as Record<string, unknown>);
  // Express leaves `{}` behind for a bodyless POST -- /auth/refresh and
  // /auth/logout send one -- and a line saying so is noise.
  if (keys.length === 0) {
    return null;
  }

  const shown = keys.slice(0, KEY_LIMIT).sort();
  return keys.length > KEY_LIMIT ? `${shown.join(', ')}, …(${keys.length} total)` : shown.join(', ');
}
