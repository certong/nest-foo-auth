import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventsModule } from '../events/events.module';
import { PortalOrigins } from '../portal/portal-origins';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwksController } from './jwks.controller';
import { TOKEN_KEYS, tokenKeysProvider } from './token-keys';

@Module({
  imports: [
    // Registered as a module, not as an APP_GUARD: only the sign-in routes are
    // throttled, via @UseGuards on the handler. A global limit would throttle
    // ordinary refreshes.
    //
    // Ten per quarter-hour: enough headroom that a mistyped password a few times
    // over does not lock the one administrator out, while still leaving a brute
    // force ten guesses per quarter-hour against an Argon2id hash.
    ThrottlerModule.forRoot([{ name: 'login', ttl: 900_000, limit: 10 }]),
    EventsModule,
  ],
  controllers: [AuthController, JwksController],
  // TOKEN_KEYS and PortalOrigins are exported for the global guards, which
  // AppModule registers so their order is explicit.
  providers: [AuthService, tokenKeysProvider, PortalOrigins],
  exports: [TOKEN_KEYS, PortalOrigins],
})
export class AuthModule {}
