import { config as loadEnvFile } from 'dotenv';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The database suite: rules only Postgres can prove — the partial unique index
 * behind "one portal_entry per session per portal", the CHECKs on auth_event,
 * and the retention DELETE. Run with
 *
 *   npm run test:db                                    # TEST_DATABASE_URL from .env
 *   TEST_DATABASE_URL=postgresql://… npm run test:db   # or passed in
 *
 * TEST_DATABASE_URL names a server and a database to connect to for admin
 * work; each run creates its own throwaway database beside it, applies this
 * repo's migrations with `prisma migrate deploy`, and drops it afterwards.
 * Nothing touches foo_platform_db. Without the variable every case is skipped.
 */

// Nest's ConfigModule reads .env for the service, and the Prisma CLI reads it
// for migrations, but vitest does not — so a developer who set
// TEST_DATABASE_URL in their env file used to get 16 silently skipped cases and
// a green run, which is the one outcome this suite exists to prevent. Loading
// it here makes `npm run test:db` behave like every other command in the repo.
//
// dotenv leaves a variable that is already set alone, so an inline
// TEST_DATABASE_URL=… still wins over .env — which is how CI passes it.
loadEnvFile({ quiet: true });

const { TEST_DATABASE_URL } = process.env;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['test/db/**/*.int-spec.ts'],
    // Spread rather than assigned: an undefined value would arrive in the test
    // process as the string "undefined", and HAS_DATABASE would then be true
    // with nothing to connect to.
    env: { TZ: 'UTC', ...(TEST_DATABASE_URL ? { TEST_DATABASE_URL } : {}) },
    // One throwaway database, migrated once, shared by the files.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
