/**
 * Creates a login account.
 *
 *   USER_EMAIL=someone@example.com USER_PASSWORD='...' npm run user:add
 *
 * Unlike `npm run seed:admin` this refuses an address that already has an
 * account rather than overwriting its password — with more than one account,
 * a typo would otherwise lock somebody out silently.
 *
 * Worth knowing before you run it: there are no roles and no per-portal grants.
 * A new account can sign in to every portal — billing and studio alike — and
 * see and change everything in each. auth_event records who signed in where;
 * nothing records what they changed once inside.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { addUser } from '../src/auth/user-admin';

async function main(): Promise<void> {
  const email = process.env.USER_EMAIL;
  const password = process.env.USER_PASSWORD;

  if (!email || !password) {
    throw new Error('USER_EMAIL and USER_PASSWORD must both be set');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const user = await addUser(app.get(PrismaService), email, password);
    console.log(`Account created: ${user.email}`);
    console.log('It can sign in with email + password. The PIN stays where it is —');
    console.log('run `npm run key:set` to move it, `npm run user:list` to see who holds it.');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
