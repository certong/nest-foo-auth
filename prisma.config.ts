import { config as loadEnvFile } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 6 read .env by itself; from 7 the CLI leaves that to this file.
// dotenv leaves a variable that is already set alone, so an inline
// DIRECT_URL=… (as test/db/throwaway-database.ts passes) still wins.
loadEnvFile({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // No migrations.path: left out, Migrate reads the migrations folder beside
  // whichever schema it is given, which is what lets test/db's deploy(upTo)
  // point --schema at a partial copy and have only those migrations applied.
  // The CLI is only ever Migrate, and Migrate needs the direct URL: the Neon
  // pooler runs in transaction mode and cannot hold Migrate's advisory lock.
  // The service connects through DATABASE_URL instead (see PrismaService).
  //
  // process.env rather than prisma/config's env(), which throws when the
  // variable is unset — and the Docker build runs `prisma generate` with no
  // database in sight.
  datasource: { url: process.env.DIRECT_URL },
});
