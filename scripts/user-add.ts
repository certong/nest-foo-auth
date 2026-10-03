/**
 * Creates a login account.
 *
 *   USER_EMAIL=someone@example.com USER_PASSWORD='...' npm run user:add
 *   USER_EMAIL=owner@client.com USER_PASSWORD='...' USER_ACCOUNT_TYPE=client USER_CLIENT_ID=42 npm run user:add
 *
 * USER_ACCOUNT_TYPE is staff (the default) or client. A client account needs
 * USER_CLIENT_ID, the billing client it belongs to, and can sign in to studio
 * only, where it sees only that client's data.
 *
 * Unlike `npm run seed:admin` this refuses an address that already has an
 * account rather than overwriting its password — with more than one account,
 * a typo would otherwise lock somebody out silently.
 *
 * Worth knowing before you run it: a staff account can sign in to every portal
 * and see and change everything in each. auth_event records who signed in
 * where; nothing records what they changed once inside.
 */
import { NestFactory } from '@nestjs/core';
import { ScriptsModule } from '../src/scripts.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { addUser } from '../src/auth/user-admin';

async function main(): Promise<void> {
  const email = process.env.USER_EMAIL;
  const password = process.env.USER_PASSWORD;
  const accountType = process.env.USER_ACCOUNT_TYPE;
  const rawClientId = process.env.USER_CLIENT_ID;
  const clientId = rawClientId === undefined || rawClientId === '' ? undefined : Number(rawClientId);

  if (!email || !password) {
    throw new Error('USER_EMAIL and USER_PASSWORD must both be set');
  }

  const app = await NestFactory.createApplicationContext(ScriptsModule, { logger: ['error'] });
  try {
    const user = await addUser(app.get(PrismaService), email, password, { accountType, clientId });
    if (user.accountType === 'client') {
      console.log(`Client account created: ${user.email} → billing client ${user.clientId}`);
      console.log('It can sign in to studio only. Check that client id exists in billing —');
      console.log('this service cannot see billing’s tables to check it for you.');
    } else {
      console.log(`Staff account created: ${user.email}`);
      console.log('It can sign in to every portal. The PIN stays where it is —');
      console.log('run `npm run key:set` to move it, `npm run user:list` to see who holds it.');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
