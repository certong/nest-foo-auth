import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';
import { PrismaService } from '../prisma/prisma.service';
import { AuthEventInput } from './auth-event';

/** auth_event.user_agent is VARCHAR(512); longer values are cut, never refused. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * Writes the login log.
 *
 * Two rules shape everything here.
 *
 * Writing the log must never change what a sign-in answers. A failed insert is
 * logged and swallowed: it does not turn a 401 into a 500, and it does not
 * block a successful login (spec 15.8). Callers still await it — so the cost is
 * the same on every failure path, and a row is not lost to a shutdown midway —
 * but nothing they do depends on the outcome.
 *
 * One portal_entry per session per portal. Every insert goes through
 * createMany with skipDuplicates, which is INSERT ... ON CONFLICT DO NOTHING;
 * the partial unique index auth_event_portal_entry_once makes the second and
 * later portal_entry for a (sid, portal) a no-op. No other kind can collide, so
 * the flag is harmless for them and keeps this to one code path.
 */
@Injectable()
export class AuthEventService {
  private readonly logger = new Logger(AuthEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(events: AuthEventInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    try {
      await this.prisma.authEvent.createMany({
        data: events.map((event) => ({
          kind: event.kind,
          portal: event.portal,
          accountId: event.accountId ?? null,
          method: event.method ?? null,
          sid: event.sid ?? null,
          ip: cleanIp(event.ip),
          userAgent: cleanUserAgent(event.userAgent),
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      // The kinds, not the rows: nothing identifying goes to the application log.
      this.logger.warn(
        `could not write auth_event (${events.map((e) => e.kind).join(', ')}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Null for anything Postgres's inet would refuse. A malformed value — a proxy
 * misconfiguration, say — would otherwise fail the whole insert and lose the
 * event, when only the address is wrong.
 */
function cleanIp(ip: string | null | undefined): string | null {
  return typeof ip === 'string' && isIP(ip) !== 0 ? ip : null;
}

function cleanUserAgent(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== 'string' || userAgent.length === 0) {
    return null;
  }
  return userAgent.slice(0, USER_AGENT_MAX_LENGTH);
}
