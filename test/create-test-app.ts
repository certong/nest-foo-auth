import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';
import { testEnv } from './test-keys';

/**
 * Boots the real AppModule wired by the same configureApp main.ts uses, so an
 * endpoint test cannot pass against an app that differs from the one deployed.
 * Callers override PrismaService rather than pointing at a database.
 *
 * The signing key, issuer and portal map are forced rather than defaulted:
 * ConfigModule has already read whichever .env target the developer has
 * active, and the suite must not pass or fail on a symlink.
 */
export async function createTestApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  env: Record<string, string> = {},
): Promise<INestApplication> {
  Object.assign(process.env, await testEnv(), env);

  const moduleRef = await configure(Test.createTestingModule({ imports: [AppModule] })).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
