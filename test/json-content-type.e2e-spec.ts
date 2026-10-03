import { INestApplication } from '@nestjs/common';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';
import { BILLING_ORIGIN } from './test-keys';

let app: INestApplication;
let port: number;

/**
 * Sends a request with no body and no Content-Length, which supertest cannot do.
 */
function rawRequest(method: string, path: string, contentType: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${BILLING_ORIGIN}\r\nContent-Type: ${contentType}\r\nConnection: close\r\n\r\n`,
      );
    });
    let response = '';
    socket.on('data', (chunk) => (response += chunk.toString()));
    socket.on('error', reject);
    socket.on('end', () => resolve(Number(response.split(' ')[1])));
  });
}

beforeAll(async () => {
  app = await createTestApp((builder) =>
    builder
      .overrideProvider(PrismaService)
      .useValue({
        account: { findUnique: () => Promise.resolve(null) },
        authEvent: { createMany: () => Promise.resolve({ count: 0 }) },
      }),
  );

  await app.listen(0);
  port = (app.getHttpServer().address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

describe('JSON content type requirement', () => {
  it('rejects a form-encoded POST with 415', async () => {
    // This is the shape a cross-site CSRF attempt takes: a plain form post the
    // browser will happily attach the refresh cookie to. (Origin is set to an
    // allowed one here so this exercises the content-type rule on its own;
    // PortalGuard would refuse a foreign origin first.)
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', BILLING_ORIGIN)
      .type('form')
      .send('email=admin@example.com&password=whatever')
      .expect(415);
  });

  it('rejects a mutating request with no content type at all', async () => {
    await request(app.getHttpServer()).post('/api/auth/logout').set('Origin', BILLING_ORIGIN).expect(415);
  });

  it('accepts a JSON POST', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(204);
  });

  // Regression: Express's req.is() reports false whenever a request carries no
  // body at all, so a bodyless POST or DELETE was rejected with 415 despite
  // declaring JSON correctly. supertest always adds Content-Length: 0, which
  // hides the bug, so these go down a raw socket to send neither a body nor a
  // length — the shape curl and some fetch implementations actually produce.
  it.each([
    ['/api/auth/logout', 204],
    ['/api/auth/refresh', 401],
  ])('accepts a bodyless POST %s that declares JSON', async (path, expected) => {
    const status = await rawRequest('POST', path, 'application/json');
    // 401 rather than 415 for refresh: it got past this guard to the cookie
    // check, which is exactly what the regression broke.
    expect(status).toBe(expected);
  });

  it('still rejects a bodyless POST that declares a form content type', async () => {
    expect(await rawRequest('POST', '/api/auth/logout', 'application/x-www-form-urlencoded')).toBe(
      415,
    );
  });

  it('accepts a content type carrying parameters', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'application/json; charset=utf-8')
      .expect(204);
  });

  it('rejects a content type that merely contains the word json', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', BILLING_ORIGIN)
      .set('Content-Type', 'text/plain+json-ish')
      .expect(415);
  });

  it('leaves GET alone', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
});
