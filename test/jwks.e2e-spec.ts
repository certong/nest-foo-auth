import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createLocalJWKSet, jwtVerify } from 'jose';
import request from 'supertest';
import { generateSigningJwk } from '../src/auth/token-keys';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { EMAIL, PASSWORD, fakePrisma } from './fake-prisma';
import { BILLING_ORIGIN, TEST_ISSUER, testKeyMaterial } from './test-keys';

let app: INestApplication;
let oldKid: string;

beforeAll(async () => {
  const { prisma } = await fakePrisma();
  const old = await generateSigningJwk('2026-09-old');
  oldKid = old.publicJwk.kid!;
  app = await createTestApp(
    (builder) =>
      builder.overrideProvider(PrismaService).useValue(prisma).overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true }),
    { AUTH_PUBLISHED_JWKS: JSON.stringify([old.publicJwk]) },
  );
});

afterAll(async () => {
  delete process.env.AUTH_PUBLISHED_JWKS;
  await app.close();
});

describe('GET /.well-known/jwks.json', () => {
  it('is served outside the api prefix, with no Origin and no token', async () => {
    await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);
    await request(app.getHttpServer()).get('/api/.well-known/jwks.json').expect(404);
  });

  it('lists the signing key first, then the rotation keys', async () => {
    const res = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);
    const { privateJwk } = await testKeyMaterial();

    expect(res.body.keys.map((k: { kid: string }) => k.kid)).toEqual([privateJwk.kid, oldKid]);
  });

  it('publishes public ES256 signing keys and never a private one', async () => {
    const res = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);

    for (const key of res.body.keys) {
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      expect(key).not.toHaveProperty('d');
    }
    expect(JSON.stringify(res.body)).not.toContain('"d"');
  });

  it('may be cached briefly', async () => {
    const res = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('verifies a token the service just issued', async () => {
    const jwks = (await request(app.getHttpServer()).get('/.well-known/jwks.json')).body;
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    const { payload, protectedHeader } = await jwtVerify(login.body.accessToken, createLocalJWKSet(jwks), {
      algorithms: ['ES256'],
      issuer: TEST_ISSUER,
      audience: 'billing',
    });
    expect(protectedHeader.kid).toBe(jwks.keys[0].kid);
    expect(payload.typ).toBe('access');
  });
});
