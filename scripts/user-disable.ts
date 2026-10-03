/**
 * Cuts a login off, or lets it back in.
 *
 *   USER_EMAIL=someone@client.com npm run user:disable
 *   USER_EMAIL=someone@client.com npm run user:enable
 *
 * A disabled account cannot sign in, and its open session ends at the next
 * refresh — at most fifteen minutes later, when its access token runs out.
 * Nothing is deleted; enabling restores the same account and its history.
 */
import { NestFactory } from '@nestjs/core';
import { setDisabled } from '../src/auth/user-admin';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScriptsModule } from '../src/scripts.module';

async function main(): Promise<void> {
  const email = process.env.USER_EMAIL;
  if (!email) {
    throw new Error('USER_EMAIL must be set');
  }
  const disable = !process.argv.includes('--enable');

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const result = await setDisabled(app.get(PrismaService), email, disable);
    console.log(
      result.disabled
        ? `Disabled ${result.email}. Its session ends within fifteen minutes.`
        : `Enabled ${result.email}. It can sign in again.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
