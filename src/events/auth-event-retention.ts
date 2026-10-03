import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export const DEFAULT_RETENTION_DAYS = 365;
export const PRUNE_BATCH_SIZE = 5000;

/** First sweep shortly after boot, off the startup path. */
const FIRST_SWEEP_DELAY_MS = 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * AUTH_EVENT_RETENTION_DAYS, or the default. Throws on anything that is not a
 * positive whole number: a typo here must not quietly become "delete
 * everything" or "keep forever".
 */
export function retentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_RETENTION_DAYS;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`AUTH_EVENT_RETENTION_DAYS must be a positive whole number of days, got "${value}"`);
  }
  return days;
}

export function retentionCutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Deletes auth_event rows created before `olderThan`, in batches, until a batch
 * deletes nothing. Returns how many went.
 *
 * Batched so one sweep never holds a long lock or writes one huge WAL burst
 * after a long gap. Idempotent, so two instances sweeping at once is harmless:
 * the loser's batches just find fewer rows. Raw SQL, so the schema is written
 * out — Prisma's ?schema=auth does not reach $executeRaw.
 */
export async function pruneAuthEvents(
  prisma: Pick<PrismaService, '$executeRaw'>,
  olderThan: Date,
  batchSize = PRUNE_BATCH_SIZE,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM auth.auth_event
      WHERE id IN (
        SELECT id FROM auth.auth_event
        WHERE created_at < ${olderThan}
        ORDER BY id
        LIMIT ${batchSize}
      )`;
    total += deleted;
    if (deleted < batchSize) {
      return total;
    }
  }
}

/**
 * Keeps about twelve months of log (spec 7.5). Runs a minute after boot and then
 * every 24 hours, on unref'd timers so it never holds the process open. Every
 * boot sweeps, so even a service that rarely stays up a full day keeps up.
 */
@Injectable()
export class AuthEventRetention implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuthEventRetention.name);
  private readonly days: number;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.days = retentionDays(config.get<string>('AUTH_EVENT_RETENTION_DAYS'));
  }

  onApplicationBootstrap(): void {
    const first = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS);
    const every = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  /** Never throws: a failed sweep is retried by the next one. */
  async sweep(now = new Date()): Promise<number> {
    try {
      const deleted = await pruneAuthEvents(this.prisma, retentionCutoff(this.days, now));
      if (deleted > 0) {
        this.logger.log(`pruned ${deleted} auth_event rows older than ${this.days} days`);
      }
      return deleted;
    } catch (error) {
      this.logger.warn(`auth_event retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }
}
