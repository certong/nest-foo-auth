import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerException, ThrottlerModule } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { testKeys } from '../../test/test-keys';
import { AuthEventService } from '../events/auth-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService, PIN_LOCKED } from './auth.service';
import { PinLoginDto } from './dto/pin-login.dto';
import { PinThrottlerFilter } from './pin-throttler.filter';
import { PinLockout } from './pin-lockout';
import { hashPassword } from './password';
import { TOKEN_KEYS } from './token-keys';

/**
 * What PortalGuard leaves behind on a request from the billing origin — the
 * one portal both doors open, so the two can be compared side by side.
 */
const REQ = { portal: 'billing', ip: '203.0.113.7', headers: { 'user-agent': 'vitest' } } as never;
const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const PIN = '042719';
const PASSWORD = 's3cret-password';

interface CookieCall {
  name: string;
  token: string;
  options: Record<string, unknown>;
}

function recordingResponse() {
  const cookies: CookieCall[] = [];
  return {
    cookies,
    res: {
      cookie: (name: string, token: string, options: Record<string, unknown>) => {
        cookies.push({ name, token, options });
      },
    } as never,
  };
}

async function buildController() {
  const user = {
    id: USER_ID,
    email: 'admin@example.com',
    passwordHash: await hashPassword(PASSWORD),
    accountType: 'staff',
    clientId: null,
    disabledAt: null,
    pin: { accountId: USER_ID, pinHash: await hashPassword(PIN) },
  };
  const account = { findUnique: () => Promise.resolve(user) };

  const moduleRef = await Test.createTestingModule({
    // The route carries @UseGuards(ThrottlerGuard), so the guard is constructed
    // even though these tests call the handler directly and never trip it.
    imports: [ThrottlerModule.forRoot([{ name: 'login', ttl: 900_000, limit: 10 }])],
    controllers: [AuthController],
    providers: [
      AuthService,
      PinLockout,
      { provide: PrismaService, useValue: { account } },
      { provide: ConfigService, useValue: new ConfigService({}) },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record: () => Promise.resolve() } },
    ],
  }).compile();

  return moduleRef.get(AuthController);
}

describe('POST /auth/pin — parity with /auth/login', () => {
  it('returns the same body shape as a password sign-in', async () => {
    const controller = await buildController();
    const viaPassword = await controller.login(
      { email: 'admin@example.com', password: PASSWORD },
      REQ,
      recordingResponse().res,
    );
    const viaPin = await controller.pinLogin({ email: 'admin@example.com', pin: PIN }, REQ, recordingResponse().res);

    expect(Object.keys(viaPin).sort()).toEqual(Object.keys(viaPassword).sort());
    expect(viaPin.user).toEqual(viaPassword.user);
    expect(typeof viaPin.accessToken).toBe('string');
  });

  it('sets a refresh cookie with identical name and attributes', async () => {
    // Nothing downstream of sign-in should be able to tell which door was used,
    // so the cookie has to match on every attribute, not just the name.
    const controller = await buildController();
    const passwordRes = recordingResponse();
    const pinRes = recordingResponse();

    await controller.login({ email: 'admin@example.com', password: PASSWORD }, REQ, passwordRes.res);
    await controller.pinLogin({ email: 'admin@example.com', pin: PIN }, REQ, pinRes.res);

    expect(pinRes.cookies).toHaveLength(1);
    expect(pinRes.cookies[0].name).toBe(passwordRes.cookies[0].name);
    expect(pinRes.cookies[0].options).toEqual(passwordRes.cookies[0].options);
  });

  it('mints a refresh token the ordinary refresh route accepts', async () => {
    const controller = await buildController();
    const { res, cookies } = recordingResponse();

    await controller.pinLogin({ email: 'admin@example.com', pin: PIN }, REQ, res);

    await expect(
      controller.refresh({ ...(REQ as object), cookies: { cp_refresh: cookies[0].token } } as never),
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });
});

describe('PinLoginDto', () => {
  const errorsFor = async (payload: unknown) =>
    validate(plainToInstance(PinLoginDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts an email and exactly six digits', async () => {
    expect(await errorsFor({ email: 'a@example.com', pin: '042719' })).toHaveLength(0);
  });

  it('lowercases and trims the email, so the lockout sees one spelling', () => {
    expect(plainToInstance(PinLoginDto, { email: '  Admin@Example.COM ', pin: '042719' }).email).toBe(
      'admin@example.com',
    );
  });

  it('rejects a PIN that is not six digits', async () => {
    for (const pin of ['12345', '1234567', 'abcdef', '12 456', '', '04271a']) {
      expect(await errorsFor({ email: 'a@example.com', pin })).not.toHaveLength(0);
    }
  });

  it('rejects a non-string PIN, rather than coercing a number', async () => {
    expect(await errorsFor({ email: 'a@example.com', pin: 42719 })).not.toHaveLength(0);
  });

  /**
   * FA-25. Omitting the email is no longer a validation failure: billing is
   * single-operator and does not ask for one. Whether its absence is ALLOWED is
   * a portal question, and this DTO cannot answer it — validation runs before
   * `Origin` has been resolved into a portal — so AuthService enforces it and
   * refuses a studio request that left it out.
   */
  it('accepts a body with no email at all', async () => {
    expect(await errorsFor({ pin: '042719' })).toHaveLength(0);
  });

  /**
   * Omitted is the only way to leave it out. An empty string or a null is a
   * malformed address, not an absent one, and treating them as "not given"
   * would let a studio caller skip the email by sending a blank one.
   */
  it('still rejects a malformed, blank or null email', async () => {
    expect(await errorsFor({ email: 'not-an-email', pin: '042719' })).not.toHaveLength(0);
    expect(await errorsFor({ email: '', pin: '042719' })).not.toHaveLength(0);
    expect(await errorsFor({ email: null, pin: '042719' })).not.toHaveLength(0);
  });

  it('rejects an unknown property, so the whitelist cannot be widened', async () => {
    expect(await errorsFor({ email: 'a@example.com', pin: '042719', password: 'x' })).not.toHaveLength(0);
  });
});

describe('PinThrottlerFilter', () => {
  function hostFor(headers: Record<string, unknown>) {
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const response = {
      getHeaders: () => headers,
      getHeader: (name: string) => headers[name.toLowerCase()],
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        sent.body = body;
        return this;
      },
    };
    return {
      sent,
      host: { switchToHttp: () => ({ getResponse: () => response }) } as ArgumentsHost,
    };
  }

  it('rewrites the throttle 429 into the lockout 429 body', async () => {
    // The two limits must not be distinguishable to the caller, or the response
    // reports which one fired and so whether that email's budget is spent.
    const { sent, host } = hostFor({ 'retry-after': '42' });
    new PinThrottlerFilter().catch(new ThrottlerException(), host);

    expect(sent.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(sent.body).toEqual({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: PIN_LOCKED,
      retryAfter: 42,
    });
  });

  it('reads the header a *named* throttler sets', async () => {
    // @nestjs/throttler suffixes the header with the throttler's name, and ours
    // is named 'login' — so a filter that only looks for a bare Retry-After
    // silently falls back to the configured ttl and overstates the wait for
    // anyone throttled partway through the window.
    const { sent, host } = hostFor({ 'retry-after-login': '137' });
    new PinThrottlerFilter().catch(new ThrottlerException(), host);

    expect(sent.body?.retryAfter).toBe(137);
  });

  it('still reports a numeric retryAfter when the guard set no header', async () => {
    // The frontend renders "try again in N" from this; a missing or non-numeric
    // value degrades the screen to a generic message.
    const { sent, host } = hostFor({});
    new PinThrottlerFilter().catch(new ThrottlerException(), host);

    expect(typeof sent.body?.retryAfter).toBe('number');
    expect(sent.body?.retryAfter).toBeGreaterThan(0);
  });

  it('ignores a header that is not a usable number', async () => {
    const { sent, host } = hostFor({ 'retry-after-login': 'soon' });
    new PinThrottlerFilter().catch(new ThrottlerException(), host);

    expect(sent.body?.retryAfter).toBeGreaterThan(0);
  });
});
