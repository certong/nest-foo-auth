import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** False when there is no database to test against; suites skip themselves. */
export const HAS_DATABASE = Boolean(TEST_DATABASE_URL);

export interface ThrowawayDatabase {
  prisma: PrismaClient;
  /** Applies every migration not yet applied, with `prisma migrate deploy`. */
  migrate(): void;
  drop(): Promise<void>;
}

/**
 * `prisma migrate deploy` against `url`. With `upTo`, only the migrations up to
 * and including that folder name: they are copied, with the schema, into a
 * temporary directory and deployed from there, which is the one way to stop
 * deploy part-way. A later full deploy then applies the rest exactly as it
 * would on a real database that was behind.
 */
function deploy(url: string, upTo?: string): void {
  let schema = 'prisma/schema.prisma';
  let scratch: string | null = null;
  if (upTo !== undefined) {
    scratch = mkdtempSync(join(tmpdir(), 'foo-auth-migrations-'));
    cpSync('prisma/schema.prisma', join(scratch, 'schema.prisma'));
    cpSync('prisma/migrations/migration_lock.toml', join(scratch, 'migrations', 'migration_lock.toml'));
    for (const name of readdirSync('prisma/migrations')) {
      if (name !== 'migration_lock.toml' && name <= upTo) {
        cpSync(join('prisma/migrations', name), join(scratch, 'migrations', name), { recursive: true });
      }
    }
    schema = join(scratch, 'schema.prisma');
  }
  try {
    // shell: true on Windows. The npx on PATH there is npx.cmd, and
    // execFileSync does not try the .cmd extension, so without this every case
    // in this suite dies with "spawnSync npx ENOENT" before its first
    // assertion. The arguments are literals, so the shell has nothing to quote.
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schema], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } finally {
    if (scratch !== null) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * Creates a database named foo_auth_test_<random> on the TEST_DATABASE_URL
 * server, runs `prisma migrate deploy` against it with ?schema=auth — the same
 * command and the same URL shape a real deployment uses — and returns a client
 * on it. The admin connection is used only for CREATE and DROP DATABASE.
 *
 * `upTo` stops at that migration, so a suite can seed the old shape and then
 * call migrate() to watch a later migration carry the rows across.
 */
export async function createThrowawayDatabase(options: { upTo?: string } = {}): Promise<ThrowawayDatabase> {
  const adminUrl = new URL(TEST_DATABASE_URL!);
  const name = `foo_auth_test_${randomBytes(4).toString('hex')}`;

  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl.toString() }) });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'auth');

  try {
    deploy(url.toString(), options.upTo);
  } catch (error) {
    // The database exists by this point, so a failure here would otherwise
    // leave it behind on the server: drop() is only reachable once this
    // function returns.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    throw error;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema: 'auth' }) });

  return {
    prisma,
    migrate() {
      deploy(url.toString());
    },
    async drop() {
      await prisma.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$disconnect();
    },
  };
}
