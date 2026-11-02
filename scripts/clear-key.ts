/**
 * Removes one account's PIN, so it can no longer use POST /auth/pin.
 *
 *   USER_EMAIL=someone@example.com npm run key:clear
 *
 * Studio takes the PIN only, so an account without one cannot sign in to
 * studio until `npm run key:set` gives it a new one.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { clearAccountPin } from '../src/auth/account-pin';

async function main(): Promise<void> {
  const email = process.env.USER_EMAIL?.trim();
  if (!email) {
    throw new Error('USER_EMAIL must be set');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const { email: updated, removed } = await clearAccountPin(app.get(PrismaService), email);
    console.log(removed ? `PIN removed for ${updated}` : `${updated} had no PIN; nothing changed`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
