import {
  Body,
  Controller,
  ForbiddenException,
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
import { AuthService, USE_PIN_SIGN_IN } from './auth.service';
import { Public } from './public.decorator';
import { PinLoginDto } from './dto/pin-login.dto';
import { PinThrottlerFilter } from './pin-throttler.filter';
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
   * Retired. Both portals sign in with a PIN: studio with email and PIN
   * (FA-24), billing with a PIN alone (FA-25). There is no portal left that a
   * password opens, so there is nothing for this route to verify.
   *
   * Kept, rather than deleted, and answering 403 with the same message studio
   * already gave a password: a caller that still posts here is a frontend
   * built against the old contract, and `Use PIN sign-in for this portal`
   * tells it what to do instead. A 404 would read as a wrong URL or a
   * half-deployed service and send someone looking in the wrong place.
   *
   * No body is read and no account is looked up, so this says nothing about
   * which addresses exist — and no password reaches the service, which is why
   * `validateCredentials` is gone rather than gated.
   */
  @Public()
  @HttpCode(HttpStatus.FORBIDDEN)
  @Post('auth/login')
  login(): never {
    throw new ForbiddenException(USE_PIN_SIGN_IN);
  }

  /**
   * Email and six-digit PIN (POST /auth/pin, FA-24). The only way into studio;
   * billing accepts it beside the password.
   *
   * From billing the email may be omitted entirely (FA-25) — that portal is
   * staff-only and single-operator, so the service resolves whose PIN it is
   * rather than making the operator type an address before six digits. Studio
   * must send one. The DTO cannot tell the two apart, because validation runs
   * before `Origin` has been resolved into a portal, so it accepts the field as
   * optional and AuthService enforces the rule.
   *
   * A new credential, not a new session mechanism: this returns byte-for-byte
   * what /auth/login returns and sets the same cookie the same way, so
   * /auth/refresh, /me, the guard and the cookie's lifetime cannot tell which
   * door was used.
   *
   * Two limits: the per-IP `login` throttle shared with /auth/login, and the
   * per-email lockout inside validatePin. PinThrottlerFilter makes their 429s
   * read identically.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @UseFilters(PinThrottlerFilter)
  @HttpCode(HttpStatus.OK)
  @Post('auth/pin')
  async pinLogin(
    @Body() dto: PinLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const meta = requestMeta(req);
    const claims = await this.authService.validatePin(dto.email, dto.pin, meta);
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
