import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { corsOptions } from './common/cors';
import { PortalOrigins } from './portal/portal-origins';

/**
 * Everything main.ts does to the app between create and listen, in one place.
 * test/create-test-app.ts calls this too, so an endpoint test cannot pass
 * against an app wired differently from the one deployed.
 */
export function configureApp(app: INestApplication): void {
  // The JWKS lives at the well-known path JWKS clients look for, outside `api`.
  app.setGlobalPrefix('api', {
    exclude: [{ path: '.well-known/jwks.json', method: RequestMethod.GET }],
  });

  // The refresh token arrives as an httpOnly cookie; without this the refresh
  // and logout handlers see no request.cookies.
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const config = app.get(ConfigService);

  // The allowlist is AUTH_PORTAL_ORIGINS — the same map PortalGuard uses, so an
  // origin cannot pass CORS without also having a portal.
  app.enableCors(corsOptions(app.get(PortalOrigins).origins(), config.get<string>('CORS_MAX_AGE')));

  // Behind a reverse proxy, every request otherwise appears to come from the
  // proxy's address: the login throttle becomes one shared global budget, and
  // every auth_event row records the proxy's IP.
  const trustProxy = config.get<string>('TRUST_PROXY');
  if (trustProxy) {
    app.getHttpAdapter().getInstance().set('trust proxy', Number(trustProxy));
  }
}
