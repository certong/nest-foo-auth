import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { requestMeta } from '../events/request-meta';
import { Portal } from '../portal/portal';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser, toAuthenticatedUser } from './authenticated-user';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { LoginDto } from './dto/login.dto';
import { KeyLoginDto } from './dto/key-login.dto';
import { KeyThrottlerFilter } from './key-throttler.filter';
import { LoginResponse, RefreshResponse } from './auth-response';
import { SessionClaims } from './session-token';
import {
  CookieConfig,
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  readCookieConfig,
  setRefreshCookie,
} from './session-cookie';

/**
 * Every route here has a portal: PortalGuard (global, first) resolved it from
 * the Origin header or already refused the request with 403.
 */
@Controller()
export class AuthController {
  private readonly cookieConfig: CookieConfig;

  constructor(
    private readonly authService: AuthService,
    configService: ConfigService,
  ) {
    // Read once at construction so a bad cookie configuration fails at boot.
    this.cookieConfig = readCookieConfig(configService);
  }

  /**
   * Returns the access token and the user, and sets the refresh cookie.
   *
   * The split is the point (CP-37): the frontend holds the access token and
   * attaches it, so it must be able to read it — and it expires in fifteen
   * minutes. The refresh token, which can mint more for twelve hours, goes
   * where script cannot reach it.
   *
   * The access token is for the portal this request came from; the cookie is
   * good at every portal, which is what signs the user in everywhere at once.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const meta = requestMeta(req);
    const claims = await this.authService.validateCredentials(dto.email, dto.password, meta);
    return this.signedIn(claims, meta.portal, res);
  }

  /**
   * The six-digit operator key (POST /auth/key).
   *
   * A new credential, not a new session mechanism: this returns byte-for-byte
   * what /auth/login returns and sets the same cookie the same way, so
   * /auth/refresh, /me, the guard and the cookie's lifetime cannot tell which
   * door was used. Anything else would make the key a second session system to
   * maintain rather than a second way into the existing one.
   *
   * The throttle stays on as a coarse per-IP ceiling, but the real control is
   * the persisted per-operator lockout inside validateKey — a per-IP, in-memory
   * limit that resets on deploy bounds a naive script and nothing else.
   * KeyThrottlerFilter makes the two 429s read identically.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @UseFilters(KeyThrottlerFilter)
  @HttpCode(HttpStatus.OK)
  @Post('auth/key')
  async keyLogin(
    @Body() dto: KeyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const meta = requestMeta(req);
    const claims = await this.authService.validateKey(dto.key, meta);
    return this.signedIn(claims, meta.portal, res);
  }

  /**
   * Public rather than guarded, necessarily: this is what a caller reaches for
   * precisely because its access token has expired, so requiring a valid one
   * would make the endpoint useless. The refresh cookie is the credential, and
   * it is verified in the service.
   *
   * This is also single sign-on: the cookie was set when the user signed in at
   * one portal, and a refresh from the other portal's origin mints a token for
   * that one.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('auth/refresh')
  async refresh(@Req() req: Request): Promise<RefreshResponse> {
    const meta = requestMeta(req);
    const claims = await this.authService.refresh(req.cookies?.[REFRESH_COOKIE_NAME], meta);
    return { accessToken: await this.authService.createAccessToken(claims, meta.portal) };
  }

  /**
   * Clears the refresh cookie, which is all a server can do: a signed JWT stays
   * valid until it expires, so access tokens already issued keep working for up
   * to fifteen minutes. What logout guarantees is that the session cannot be
   * extended past that — at any portal, since there is one cookie for all.
   *
   * Public on purpose: signing out from a tab whose token has already expired
   * must still clear browser state, not 401.
   */
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.logout(req.cookies?.[REFRESH_COOKIE_NAME], requestMeta(req));
    clearRefreshCookie(res, this.cookieConfig);
  }

  /**
   * The bearer token's user. JwtAuthGuard has already required the token's
   * audience to be this request's portal.
   */
  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /**
   * The user is built by toAuthenticatedUser, never by spreading the claims:
   * SessionClaims also carries `sid`, which does not belong in a body.
   */
  private async signedIn(claims: SessionClaims, portal: Portal, res: Response): Promise<LoginResponse> {
    setRefreshCookie(res, await this.authService.createRefreshToken(claims), this.cookieConfig);
    return {
      accessToken: await this.authService.createAccessToken(claims, portal),
      user: toAuthenticatedUser(claims),
    };
  }
}
