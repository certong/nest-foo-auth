/**
 * Points git at the tracked .githooks directory, so the Prisma-client sync
 * hooks are active in every clone without anyone having to remember a setup
 * step. Run automatically by the `prepare` npm script.
 *
 * Node rather than a shell one-liner in package.json: npm runs scripts through
 * cmd.exe on Windows, where `>/dev/null` and `||` do not mean what they mean in
 * sh, and the whole thing fails with "The system cannot find the path
 * specified".
 */
import { execFileSync } from 'node:child_process';

// A tarball install, a Docker build context without .git, a vendored copy —
// none of these are a working tree, and none of them want hooks.
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('git hooks active: .githooks (Prisma client stays in step with the schema)');
} catch {
  // Never fail an install over this. The hooks are a convenience; the fallback
  // is the same command everyone already knows.
  console.warn("could not set core.hooksPath — run 'npm run prisma:generate' by hand after a branch switch.");
}
