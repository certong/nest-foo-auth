import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JsonContentTypeGuard } from './common/json-content-type.guard';
import { HealthController } from './health/health.controller';
import { PortalGuard } from './portal/portal.guard';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule],
  controllers: [HealthController],
  // Global guards run in the order listed here, which is why all three live in
  // one place:
  //
  //   1. PortalGuard — no portal, no further work: an unknown origin is refused
  //      before any credential is read or any Argon2 time is spent.
  //   2. JsonContentTypeGuard — the CSRF control on mutating requests.
  //   3. JwtAuthGuard — the bearer token, with its audience checked against the
  //      portal guard 1 resolved.
  providers: [
    { provide: APP_GUARD, useClass: PortalGuard },
    { provide: APP_GUARD, useClass: JsonContentTypeGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
