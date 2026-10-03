/**
 * Lists every login account: its type (staff, or client and which billing
 * client), whether it is disabled, and which one the PIN opens.
 *
 *   npm run user:list
 *
 * POST /auth/key will not tell you which account it signs in as — every
 * rejection it gives is deliberately uniform — so this is the only way to find
 * out.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { listUsers } from '../src/auth/user-admin';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const users = await listUsers(app.get(PrismaService));

    if (users.length === 0) {
      console.log('No accounts. Create one with `npm run user:add`.');
      return;
    }

    const width = Math.max(...users.map((u) => u.email.length));
    for (const user of users) {
      const created = user.createdAt.toISOString().slice(0, 10);
      const type = user.accountType === 'client' ? `client #${user.clientId}` : 'staff';
      console.log(
        `${user.email.padEnd(width)}  ${type.padEnd(14)}  created ${created}` +
          `${user.disabled ? '  DISABLED' : ''}${user.holdsKey ? '  ← holds the PIN' : ''}`,
      );
    }
    if (!users.some((u) => u.holdsKey)) {
      console.log('\nNo PIN is configured. `npm run key:set` designates an account.');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
