import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';

// Host only. The connection string carries the password, so it must never be
// logged whole.
function databaseHost(url: string | undefined): string {
  if (!url) return 'unset';
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 3001;
  await app.listen(port);

  // Locally .env is a symlink to .env.local/.dev/.uat (see scripts/use-env.sh).
  // Announce which one is live, so a session pointed at the wrong database says
  // so on its first line of output instead of on its first write.
  new Logger('Bootstrap').log(
    `listening on ${port} — APP_ENV=${configService.get<string>('APP_ENV') ?? 'unset'} ` +
      `db=${databaseHost(configService.get<string>('DATABASE_URL'))} ` +
      `issuer=${configService.get<string>('AUTH_ISSUER')}`,
  );
}

bootstrap();
