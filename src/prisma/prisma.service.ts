import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Refuses a DATABASE_URL that does not select schema `auth`.
 *
 * Prisma takes the schema from the URL's `schema=` parameter and falls back to
 * `public` without a word, so a URL missing it boots, passes the health check,
 * and fails on the first login with "The table `public.account_pin` does not
 * exist". The usual way to lose it on Neon is a second `?`: the URL already
 * has `?sslmode=require`, so the parameter must be joined with `&`, and
 * `...?sslmode=require?schema=auth` parses as an sslmode with a strange value.
 *
 * Says what it found but never the URL: that carries the password.
 */
export function requireAuthSchema(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL is not set.');
  let schema: string | null;
  try {
    schema = new URL(url).searchParams.get('schema');
  } catch {
    throw new Error('DATABASE_URL is not a URL.');
  }
  if (schema !== 'auth') {
    throw new Error(
      `DATABASE_URL must end in schema=auth, joined to the other parameters with "&" (see .env.example); ` +
        (schema === null ? 'it has no schema parameter, so Prisma would read `public`.' : `it says schema=${schema}.`),
    );
  }
  return url;
}

// No eager $connect() in onModuleInit: Prisma connects on the first query.
// Connecting at boot made app.listen() wait for Neon to resume from
// auto-suspend, stacking the database wake-up onto every container cold start.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(configService: ConfigService) {
    super({
      datasources: {
        db: { url: requireAuthSchema(configService.get<string>('DATABASE_URL')) },
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
