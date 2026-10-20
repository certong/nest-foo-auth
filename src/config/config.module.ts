import { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { assertNoDuplicateEnvKeys } from './env-file';

/**
 * ConfigModule, with the .env checked for repeated keys first.
 *
 * Both AppModule and ScriptsModule go through here, so `npm start` and every
 * script in scripts/ get the same check from one definition. It runs before
 * ConfigModule.forRoot reads the file, and throws rather than warns: a
 * repeated key means the file does not say what it appears to, and the whole
 * point of having one .env is being able to read it.
 *
 * Not covered: the Prisma CLI. `npx prisma migrate deploy` reads .env itself
 * and never loads this, so it still takes the last DATABASE_URL without
 * comment. That is the path with the most to lose, and the reason the warning
 * in .env.example stays where it is.
 */
export function envConfigModule(): Promise<DynamicModule> {
  // Synchronous, and before forRoot is even called: the file is read and
  // judged here, not whenever Nest resolves the module it returns.
  assertNoDuplicateEnvKeys();
  return ConfigModule.forRoot({ isGlobal: true });
}
