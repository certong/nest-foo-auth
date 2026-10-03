import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { BILLING_ORIGIN } from './test-keys';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp((builder) =>
    builder
      .overrideProvider(PrismaService)
      .useValue({
        account: { findUnique: () => Promise.resolve(null) },
        authEvent: { createMany: () => Promise.resolve({ count: 0 }) },
      }),
  );
});

afterAll(async () => {
  await app.close();
});

describe('login throttling', () => {
  it('allows ten attempts then answers 429', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', BILLING_ORIGIN)
        .send({ email: 'nobody@example.com', password: 'wrong' });

    for (let i = 0; i < 10; i += 1) {
      await attempt().expect(401);
    }
    await attempt().expect(429);
  });

  it('leaves other routes unthrottled', async () => {
    // The rest of the API is authenticated; only the unauthenticated login route
    // is worth a rate limit, and a global one would throttle normal use.
    for (let i = 0; i < 15; i += 1) {
      await request(app.getHttpServer()).get('/api/me').set('Origin', BILLING_ORIGIN).expect(401);
    }
  });
});
