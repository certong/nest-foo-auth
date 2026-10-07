/**
 * Creates or updates a staff account's password.
 *
 * Re-runnable, and deliberately so: there is no password reset flow, so running
 * this again with a new ADMIN_PASSWORD is how the password gets changed and how
 * a lost password is recovered.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run seed:admin
 *
 * It manages staff accounts only. A client login's password is refused rather
 * than reset — see seedAdmin in src/auth/user-admin.ts.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedAdmin } from '../src/auth/user-admin';

async function main(): Promise<void> {
  // Normalised before the emptiness check, so ADMIN_EMAIL='   ' is "unset"
  // rather than an account with a blank address.
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must both be set');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const user = await seedAdmin(app.get(PrismaService), email, password);
    console.log(`Administrator ready: ${user.email}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
