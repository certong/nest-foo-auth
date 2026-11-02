import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { HttpLogMiddleware } from './http-log.middleware';

interface RequestShape {
  method?: string;
  url?: string;
  body?: unknown;
  userId?: string;
  portal?: string;
}

function requestFor({ method = 'GET', url = '/api/me', body, userId, portal }: RequestShape): Request {
  return {
    method,
    originalUrl: url,
    headers: {},
    body,
    ...(userId ? { user: { id: userId } } : {}),
    ...(portal ? { portal } : {}),
  } as unknown as Request;
}

/** A response that only has to carry a status and announce that it finished. */
function responseFor(statusCode: number): Response & { finish: () => void } {
  const emitter = new EventEmitter() as EventEmitter & { statusCode: number };
  emitter.statusCode = statusCode;
  const response = emitter as unknown as Response & { finish: () => void };
  response.finish = () => emitter.emit('finish');
  return response;
}

/**
 * Runs a request through and returns everything logged, so a spec asserts on
 * the lines a developer actually sees rather than on internals.
 */
function linesFor(appEnv: string, request: RequestShape, statusCode = 200): string[] {
  const logged: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    logged.push(String(message));
  });

  try {
    const next = vi.fn() as unknown as NextFunction;
    const response = responseFor(statusCode);
    new HttpLogMiddleware(new ConfigService({ APP_ENV: appEnv })).use(requestFor(request), response, next);
    expect(next).toHaveBeenCalled();
    response.finish();
  } finally {
    spy.mockRestore();
  }

  return logged;
}

describe('HttpLogMiddleware — when it speaks', () => {
  it('logs method, path, status, duration, portal and user at APP_ENV=local', () => {
    const [line] = linesFor('local', { url: '/api/me', userId: '7c134fee-0112-42b2', portal: 'billing' });

    expect(line).toMatch(/^GET \/api\/me 200 \d+ms portal=billing user=7c134fee$/);
  });

  it.each(['dev', 'uat', 'production', 'localhost', 'unset', ''])('logs nothing at APP_ENV=%s', (appEnv) => {
    // `localhost` is in this list on purpose: nest-foo-billing gates on that
    // spelling while its own .env.example ships APP_ENV=local, so its logging
    // is off in a fresh clone. This service follows its .env.example instead.
    expect(linesFor(appEnv, { method: 'POST', url: '/api/auth/pin', body: { pin: '042719' } })).toEqual([]);
  });

  it('calls next even when it is switched off, so nothing hangs', () => {
    const next = vi.fn() as unknown as NextFunction;
    new HttpLogMiddleware(new ConfigService({ APP_ENV: 'uat' })).use(requestFor({}), responseFor(200), next);

    expect(next).toHaveBeenCalled();
  });

  it('shows a dash for each of portal and user when no guard reached them', () => {
    // What a 403 on the origin rule looks like: refused before either was set.
    const [line] = linesFor('local', { method: 'POST', url: '/api/auth/pin' }, 403);

    expect(line).toContain('403');
    expect(line).toContain('portal=- user=-');
  });
});

describe('HttpLogMiddleware — what it will not print', () => {
  it('never prints a value from the body, only the key names', () => {
    const lines = linesFor('local', {
      method: 'POST',
      url: '/api/auth/pin',
      body: { email: 'admin@example.com', pin: '042719' },
    });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('  body keys: email, pin');
    const whole = lines.join('\n');
    expect(whole).not.toContain('042719');
    expect(whole).not.toContain('admin@example.com');
  });

  it('prints no value even for a key it has never heard of', () => {
    // The guarantee is the shape of the line, not a list of known-bad keys, so
    // a DTO added later cannot leak by being unlisted.
    const lines = linesFor('local', {
      method: 'POST',
      url: '/api/auth/pin',
      body: { somethingNew: 'hunter2', password: 'hunter2' },
    });

    expect(lines[1]).toBe('  body keys: password, somethingNew');
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('is the diagnostic for a 400: which keys were sent, not what they held', () => {
    // A pin-only body at studio, which FA-25 answers 400 for. The missing
    // `email` is the whole story and the keys tell it.
    const lines = linesFor('local', { method: 'POST', url: '/api/auth/pin', body: { pin: '042719' } }, 400);

    expect(lines[0]).toContain('400');
    expect(lines[1]).toBe('  body keys: pin');
  });
});

describe('HttpLogMiddleware — when it stays quiet about the body', () => {
  it('says nothing about a GET, which has no body worth a line', () => {
    expect(linesFor('local', { method: 'GET', url: '/api/me' })).toHaveLength(1);
  });

  it('says nothing for the empty object express leaves on a bodyless POST', () => {
    // /auth/refresh and /auth/logout both send one.
    expect(linesFor('local', { method: 'POST', url: '/api/auth/refresh', body: {} })).toHaveLength(1);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'raw'],
    ['an array', [1, 2]],
  ])('says nothing for a body that is %s', (_name, body) => {
    expect(linesFor('local', { method: 'POST', url: '/api/auth/pin', body })).toHaveLength(1);
  });

  it('caps a body with absurdly many keys rather than filling the terminal', () => {
    const body = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const lines = linesFor('local', { method: 'POST', url: '/api/auth/pin', body });

    expect(lines[1]).toContain('…(20 total)');
    expect(lines[1]).not.toContain('k19');
  });
});
