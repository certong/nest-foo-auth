import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    // `*spec.ts`, not `*.spec.ts`: the endpoint suites follow Nest's
    // `*.e2e-spec.ts` convention, which has a hyphen rather than a dot.
    include: ['src/**/*.spec.ts', 'test/**/*spec.ts'],
    // The database suite has its own config (vitest.db.config.mts, npm run
    // test:db); the default run stays database-free.
    exclude: ['test/db/**', 'node_modules/**'],
    // The deployed image (no TZ set) runs UTC, so the suite runs UTC too —
    // otherwise time-based behaviour (token expiry, the retention cutoff) can
    // pass on a developer's machine in +07 and fail in the container.
    env: { TZ: 'UTC' },
  },
  plugins: [
    // Nest resolves constructor dependencies from `emitDecoratorMetadata`, which
    // vitest's default esbuild transform drops silently. swc keeps it, so this
    // plugin is what makes dependency injection work under test at all.
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
