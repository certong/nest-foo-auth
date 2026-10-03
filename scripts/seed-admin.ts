/**
 * Creates or updates the single administrator account.
 *
 * Re-runnable, and deliberately so: there is no password reset flow, so running
 * this again with a new ADMIN_PASSWORD is how the password gets changed and how
 * a lost password is recovered.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run seed:admin
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/auth/password';

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must both be set');
  }
  if (password.length < 12) {
    // The only account on the system, behind a public login route. A short
    // password here is the whole attack surface.
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  const passwordHash = await hashPassword(password);
  const user = await prisma.account.upsert({
    where: { email },
    create: { email, passwordHash },
    update: { passwordHash },
  });

  console.log(`Administrator ready: ${user.email}`);
  await app.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
