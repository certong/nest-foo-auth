import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The database suite: rules only Postgres can prove — the partial unique index
 * behind "one portal_entry per session per portal", the CHECKs on auth_event,
 * and the retention DELETE. Run with
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/postgres npm run test:db
 *
 * TEST_DATABASE_URL names a server and a database to connect to for admin
 * work; each run creates its own throwaway database beside it, applies this
 * repo's migrations with `prisma migrate deploy`, and drops it afterwards.
 * Nothing touches foo_platform_db. Without the variable every case is skipped.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['test/db/**/*.int-spec.ts'],
    env: { TZ: 'UTC' },
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
