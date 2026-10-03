import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { EMAIL, PASSWORD, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN, STUDIO_ORIGIN } from './test-keys';

let app: INestApplication;
let findUnique: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const fake = await fakePrisma();
  findUnique = fake.findUnique;
  app = await createTestApp((builder) =>
    builder.overrideProvider(PrismaService).useValue(fake.prisma).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }),
  );
});

afterAll(async () => {
  await app.close();
});

const audOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).aud;

const login = (origin?: string, body: Record<string, unknown> = { email: EMAIL, password: PASSWORD }) => {
  const req = request(app.getHttpServer()).post('/api/auth/login');
  return (origin === undefined ? req : req.set('Origin', origin)).send(body);
};

describe('the portal comes from the Origin header', () => {
  it.each([
    [BILLING_ORIGIN, 'billing'],
    [STUDIO_ORIGIN, 'studio'],
  ])('a sign-in from %s gets a %s token', async (origin, portal) => {
    const res = await login(origin).expect(200);
    expect(audOf(res.body.accessToken)).toBe(portal);
  });

  it('refuses a request with no Origin, before the account is looked up', async () => {
    findUnique.mockClear();
    const res = await login(undefined).expect(403);

    expect(res.body).toEqual({ statusCode: 403, error: 'Forbidden', message: 'Origin not allowed' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses an unknown Origin the same way', async () => {
    findUnique.mockClear();
    await login('https://evil.example').expect(403);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses refresh, logout and /me from an unknown Origin too', async () => {
    const server = app.getHttpServer();
    await request(server).post('/api/auth/refresh').set('Origin', 'https://evil.example').send({}).expect(403);
    await request(server).post('/api/auth/logout').set('Origin', 'https://evil.example').send({}).expect(403);
    await request(server).get('/api/me').set('Origin', 'https://evil.example').expect(403);
  });

  it('will not take the portal from the body', async () => {
    await login(BILLING_ORIGIN, { email: EMAIL, password: PASSWORD, portal: 'studio' }).expect(400);
  });

  it('leaves the health check reachable with no Origin', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
});

describe('CORS follows the same map', () => {
  it.each([BILLING_ORIGIN, STUDIO_ORIGIN])('allows a preflight from %s, with credentials', async (origin) => {
    const res = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow a preflight from anywhere else', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
