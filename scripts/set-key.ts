/**
 * Sets, rotates or removes the six-digit PIN used by POST /auth/key.
 *
 *   OPERATOR_EMAIL=you@example.com OPERATOR_KEY=042719 npm run key:set
 *   OPERATOR_EMAIL=you@example.com OPERATOR_KEY= npm run key:set    # remove it
 *
 * Points the door at OPERATOR_EMAIL, so it is also how the PIN moves from one
 * account to another. Run `npm run user:list` to see which account holds it.
 *
 * This is also the unlock: setting a key clears any lockout in force. It is no
 * longer the *only* one, though — signing in with the account's password clears
 * the lockout too (see AuthService.validateCredentials), which is why the
 * password screen is worth keeping reachable.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { clearAccountPin, setAccountPin } from '../src/auth/account-pin';

async function main(): Promise<void> {
  const email = process.env.OPERATOR_EMAIL?.trim().toLowerCase();
  const key = process.env.OPERATOR_KEY;

  if (!email) {
    throw new Error('OPERATOR_EMAIL must be set');
  }
  if (key === undefined) {
    // An unset variable is a mistake; an explicitly empty one is "remove the
    // key". Treating them alike would make a typo silently disable sign-in.
    throw new Error('OPERATOR_KEY must be set (use OPERATOR_KEY= to remove the key)');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  try {
    // No row-count check. There used to be one, refusing to run unless the
    // account table held exactly one row — which would have turned "a second
    // account exists"
    // into "nobody can ever unlock the PIN again", since this script is the
    // recovery path. The door is a row of its own now; any number of accounts
    // may exist beside it.
    if (key === '') {
      await clearAccountPin(prisma);
      console.log('PIN removed — password sign-in only');
    } else {
      const { email: updated } = await setAccountPin(prisma, email, key);
      console.log(`PIN set for ${updated} — any lockout has been cleared`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
