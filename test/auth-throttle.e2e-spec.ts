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

  it('throttles PIN sign-in the same way, with a 429 shaped like the lockout’s', async () => {
    // Distinct emails each time, so the per-email lockout never fires and the
    // 429 can only be the throttle's.
    const attempt = (i: number) =>
      request(app.getHttpServer())
        .post('/api/auth/pin')
        .set('Origin', BILLING_ORIGIN)
        .send({ email: `nobody${i}@example.com`, pin: '000000' });

    for (let i = 0; i < 10; i += 1) {
      await attempt(i).expect(401);
    }
    const throttled = await attempt(10).expect(429);
    expect(throttled.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many attempts',
      retryAfter: expect.any(Number),
    });
  });

  it('leaves other routes unthrottled', async () => {
    // The rest of the API is authenticated; only the unauthenticated login route
    // is worth a rate limit, and a global one would throttle normal use.
    for (let i = 0; i < 15; i += 1) {
      await request(app.getHttpServer()).get('/api/me').set('Origin', BILLING_ORIGIN).expect(401);
    }
  });
});
