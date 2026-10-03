import { Controller, Get, Header, Inject } from '@nestjs/common';
import { JWK } from 'jose';
import { NoPortal } from '../portal/no-portal.decorator';
import { Public } from './public.decorator';
import { TOKEN_KEYS, TokenKeys } from './token-keys';

/**
 * The public keys that verify this service's tokens (RFC 7517), at
 * /.well-known/jwks.json — outside the `api` prefix, where JWKS clients look.
 *
 * Fetched server-to-server by billing and studio, so it needs no Origin and no
 * token. Five minutes of caching: short enough that a key added for rotation is
 * visible well inside the verifiers' own ten-minute cache, long enough that a
 * burst of verifier restarts is not a burst here.
 */
@Controller()
export class JwksController {
  constructor(@Inject(TOKEN_KEYS) private readonly keys: TokenKeys) {}

  @Public()
  @NoPortal()
  @Get('.well-known/jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  jwks(): { keys: JWK[] } {
    return this.keys.jwks;
  }
}
