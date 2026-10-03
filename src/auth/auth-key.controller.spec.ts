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
import { AuthService, KEY_LOCKED } from './auth.service';
import { KeyLoginDto } from './dto/key-login.dto';
import { KeyThrottlerFilter } from './key-throttler.filter';
import { hashPassword } from './password';
import { TOKEN_KEYS } from './token-keys';

/** What PortalGuard leaves behind on a request from the billing origin. */
const REQ = { portal: 'billing', ip: '203.0.113.7', headers: { 'user-agent': 'vitest' } } as never;
const USER_ID = 'a3f1c2d4-0000-4000-8000-000000000001';
const KEY = '042719';
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
    keyHash: await hashPassword(KEY),
    accountType: 'staff',
    clientId: null,
    disabledAt: null,
  };
  const account = { findUnique: () => Promise.resolve(user) };
  // The door points at this account, so both sign-in routes touch it: /auth/key
  // reads it, and /auth/login clears any lockout on it.
  const door = {
    accountId: user.id,
    keyHash: user.keyHash,
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCount: 0,
    account: user,
  };
  const accountPin = {
    upsert: () => Promise.resolve(door),
    findUnique: () => Promise.resolve(door),
    update: () => Promise.resolve(door),
    updateMany: () => Promise.resolve({ count: 1 }),
  };

  const moduleRef = await Test.createTestingModule({
    // The route carries @UseGuards(ThrottlerGuard), so the guard is constructed
    // even though these tests call the handler directly and never trip it.
    imports: [ThrottlerModule.forRoot([{ name: 'login', ttl: 900_000, limit: 10 }])],
    controllers: [AuthController],
    providers: [
      AuthService,
      { provide: PrismaService, useValue: { account, accountPin } },
      { provide: ConfigService, useValue: new ConfigService({}) },
      { provide: TOKEN_KEYS, useValue: await testKeys() },
      { provide: AuthEventService, useValue: { record: () => Promise.resolve() } },
    ],
  }).compile();

  return moduleRef.get(AuthController);
}

describe('POST /auth/key — parity with /auth/login', () => {
  it('returns the same body shape as a password sign-in', async () => {
    const controller = await buildController();
    const viaPassword = await controller.login(
      { email: 'admin@example.com', password: PASSWORD },
      REQ,
      recordingResponse().res,
    );
    const viaKey = await controller.keyLogin({ key: KEY }, REQ, recordingResponse().res);

    expect(Object.keys(viaKey).sort()).toEqual(Object.keys(viaPassword).sort());
    expect(viaKey.user).toEqual(viaPassword.user);
    expect(typeof viaKey.accessToken).toBe('string');
  });

  it('sets a refresh cookie with identical name and attributes', async () => {
    // Nothing downstream of sign-in should be able to tell which door was used,
    // so the cookie has to match on every attribute, not just the name.
    const controller = await buildController();
    const passwordRes = recordingResponse();
    const keyRes = recordingResponse();

    await controller.login({ email: 'admin@example.com', password: PASSWORD }, REQ, passwordRes.res);
    await controller.keyLogin({ key: KEY }, REQ, keyRes.res);

    expect(keyRes.cookies).toHaveLength(1);
    expect(keyRes.cookies[0].name).toBe(passwordRes.cookies[0].name);
    expect(keyRes.cookies[0].options).toEqual(passwordRes.cookies[0].options);
  });

  it('mints a refresh token the ordinary refresh route accepts', async () => {
    const controller = await buildController();
    const { res, cookies } = recordingResponse();

    await controller.keyLogin({ key: KEY }, REQ, res);

    await expect(
      controller.refresh({ ...(REQ as object), cookies: { cp_refresh: cookies[0].token } } as never),
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });
});

describe('KeyLoginDto', () => {
  const errorsFor = async (payload: unknown) =>
    validate(plainToInstance(KeyLoginDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts exactly six digits', async () => {
    expect(await errorsFor({ key: '042719' })).toHaveLength(0);
  });

  it('rejects a key that is not six digits', async () => {
    for (const key of ['12345', '1234567', 'abcdef', '12 456', '', '04271a']) {
      expect(await errorsFor({ key })).not.toHaveLength(0);
    }
  });

  it('rejects a non-string key, rather than coercing a number', async () => {
    expect(await errorsFor({ key: 42719 })).not.toHaveLength(0);
  });

  it('rejects an unknown property, so the whitelist cannot be widened', async () => {
    expect(await errorsFor({ key: '042719', email: 'a@b.c' })).not.toHaveLength(0);
  });
});

describe('KeyThrottlerFilter', () => {
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
    // reports which one fired and so whether the operator's budget is spent.
    const { sent, host } = hostFor({ 'retry-after': '42' });
    new KeyThrottlerFilter().catch(new ThrottlerException(), host);

    expect(sent.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(sent.body).toEqual({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: KEY_LOCKED,
      retryAfter: 42,
    });
  });

  it('reads the header a *named* throttler sets', async () => {
    // @nestjs/throttler suffixes the header with the throttler's name, and ours
    // is named 'login' — so a filter that only looks for a bare Retry-After
    // silently falls back to the configured ttl and overstates the wait for
    // anyone throttled partway through the window.
    const { sent, host } = hostFor({ 'retry-after-login': '137' });
    new KeyThrottlerFilter().catch(new ThrottlerException(), host);

    expect(sent.body?.retryAfter).toBe(137);
  });

  it('still reports a numeric retryAfter when the guard set no header', async () => {
    // The frontend renders "try again in N" from this; a missing or non-numeric
    // value degrades the screen to a generic message.
    const { sent, host } = hostFor({});
    new KeyThrottlerFilter().catch(new ThrottlerException(), host);

    expect(typeof sent.body?.retryAfter).toBe('number');
    expect(sent.body?.retryAfter).toBeGreaterThan(0);
  });

  it('ignores a header that is not a usable number', async () => {
    const { sent, host } = hostFor({ 'retry-after-login': 'soon' });
    new KeyThrottlerFilter().catch(new ThrottlerException(), host);

    expect(sent.body?.retryAfter).toBeGreaterThan(0);
  });
});
