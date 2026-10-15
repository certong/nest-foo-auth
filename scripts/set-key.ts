/**
 * Sets or replaces one account's six-digit PIN, used by POST /auth/pin.
 *
 *   USER_EMAIL=someone@example.com USER_PIN=042719 npm run key:set
 *
 * Any account, staff or client. Run `npm run user:list` to see who has a PIN,
 * and `npm run key:clear` to remove one.
 *
 * This does not clear a lockout: that lives in the running service's memory
 * and ends by itself after fifteen minutes, or on a restart.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { setAccountPin } from '../src/auth/account-pin';

async function main(): Promise<void> {
  const email = process.env.USER_EMAIL?.trim();
  const pin = process.env.USER_PIN;

  if (!email) {
    throw new Error('USER_EMAIL must be set');
  }
  if (!pin) {
    // An empty PIN used to mean "remove it". That is key:clear now, so an empty
    // value here is a mistake rather than a quiet removal.
    throw new Error('USER_PIN must be set to six digits (to remove a PIN, use `npm run key:clear`)');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const { email: updated } = await setAccountPin(app.get(PrismaService), email, pin);
    console.log(`PIN set for ${updated}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
