/**
 * Deletes auth_event rows older than AUTH_EVENT_RETENTION_DAYS (default 365).
 *
 *   npm run events:prune
 *
 * The running service already does this a minute after boot and every 24 hours;
 * this is the same sweep, on demand.
 */
import { NestFactory } from '@nestjs/core';
import { pruneAuthEvents, retentionCutoff, retentionDays } from '../src/events/auth-event-retention';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScriptsModule } from '../src/scripts.module';

async function main(): Promise<void> {
  const days = retentionDays(process.env.AUTH_EVENT_RETENTION_DAYS);
  const cutoff = retentionCutoff(days);

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const deleted = await pruneAuthEvents(app.get(PrismaService), cutoff);
    console.log(`Deleted ${deleted} auth_event rows created before ${cutoff.toISOString()} (${days} days).`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
