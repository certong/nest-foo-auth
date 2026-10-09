import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { TOKEN_KEYS } from './auth/token-keys';
import { AuthEventRetention } from './events/auth-event-retention';
import { PortalOrigins } from './portal/portal-origins';
import { PrismaService } from './prisma/prisma.service';
import { ScriptsModule } from './scripts.module';

/**
 * What the admin scripts boot (spec 15.9). The point of this module is what it
 * leaves out: booting AppModule instead would demand AUTH_SIGNING_JWK and
 * AUTH_PORTAL_ORIGINS just to add an account, so `npm run user:add` would need
 * the production signing key on whatever machine it is run from — and it would
 * start the retention sweep, which deletes rows, as a side effect of listing
 * users.
 *
 * DATABASE_URL has to be something: PrismaClient's constructor rejects an empty
 * datasource. Nothing ever connects to it — PrismaService deliberately has no
 * eager $connect, so the client is built and no socket is opened.
 */

const SAVED = { ...process.env };
let context: INestApplicationContext | undefined;

beforeEach(() => {
  delete process.env.AUTH_ISSUER;
  delete process.env.AUTH_SIGNING_JWK;
  delete process.env.AUTH_PUBLISHED_JWKS;
  delete process.env.AUTH_PORTAL_ORIGINS;
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused?schema=auth';
});

afterEach(async () => {
  await context?.close();
  context = undefined;
  // Restored wholesale rather than key by key: ConfigModule.forRoot also reads
  // whatever .env the developer has active into process.env, so the set of keys
  // to undo is not known in advance.
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
});

const boot = async (): Promise<INestApplicationContext> => {
  context = await NestFactory.createApplicationContext(ScriptsModule, { logger: false });
  return context;
};

describe('ScriptsModule', () => {
  it('boots with no signing key and no portal map, and hands over the database', async () => {
    const app = await boot();

    // Its own method rather than `toBeInstanceOf`: Prisma's constructor returns a
    // Proxy, so `prisma instanceof PrismaService` is false even though this is
    // the provider Nest built. (vitest then blows the stack diffing the Proxy.)
    expect(typeof app.get(PrismaService).$disconnect).toBe('function');
    expect(app.get(ConfigService)).toBeInstanceOf(ConfigService);
  });

  it('never asks for the signing key or the portal map', async () => {
    // Structural, and so true whichever .env the developer has active: these
    // providers are not in the container at all, which is why their
    // configuration is never read and never validated.
    const app = await boot();

    expect(() => app.get(TOKEN_KEYS)).toThrow();
    expect(() => app.get(PortalOrigins)).toThrow();
  });

  it('starts no retention sweep, so listing users deletes nothing', async () => {
    const app = await boot();

    expect(() => app.get(AuthEventRetention)).toThrow();
  });
});
