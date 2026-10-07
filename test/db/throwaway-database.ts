import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** False when there is no database to test against; suites skip themselves. */
export const HAS_DATABASE = Boolean(TEST_DATABASE_URL);

export interface ThrowawayDatabase {
  prisma: PrismaClient;
  drop(): Promise<void>;
}

/**
 * Creates a database named foo_auth_test_<random> on the TEST_DATABASE_URL
 * server, runs `prisma migrate deploy` against it with ?schema=auth — the same
 * command and the same URL shape a real deployment uses — and returns a client
 * on it. The admin connection is used only for CREATE and DROP DATABASE.
 */
export async function createThrowawayDatabase(): Promise<ThrowawayDatabase> {
  const adminUrl = new URL(TEST_DATABASE_URL!);
  const name = `foo_auth_test_${randomBytes(4).toString('hex')}`;

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'auth');

  try {
    // shell: true on Windows. The npx on PATH there is npx.cmd, and
    // execFileSync does not try the .cmd extension, so without this every case
    // in this suite dies with "spawnSync npx ENOENT" before its first
    // assertion. The arguments are literals, so the shell has nothing to quote.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString() },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // The database exists by this point, so a failure here would otherwise
    // leave it behind on the server: drop() is only reachable once this
    // function returns.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    throw error;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

  return {
    prisma,
    async drop() {
      await prisma.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$disconnect();
    },
  };
}
