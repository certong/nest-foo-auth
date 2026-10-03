import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ORIGIN_NOT_ALLOWED, PortalGuard } from './portal.guard';
import { PortalOrigins } from './portal-origins';

const ORIGINS = 'https://billing.example.com=billing,https://studio.example.com=studio';

function contextWith(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(exempt = false): PortalGuard {
  const reflector = { getAllAndOverride: () => exempt } as unknown as Reflector;
  return new PortalGuard(reflector, new PortalOrigins(new ConfigService({ AUTH_PORTAL_ORIGINS: ORIGINS })));
}

describe('PortalGuard', () => {
  it.each([
    ['https://billing.example.com', 'billing'],
    ['https://studio.example.com', 'studio'],
  ])('resolves %s to the %s portal', (origin, portal) => {
    const request: Record<string, unknown> = { headers: { origin } };
    expect(buildGuard().canActivate(contextWith(request))).toBe(true);
    expect(request.portal).toBe(portal);
  });

  it.each([
    ['no headers', {}],
    ['no Origin header', { headers: {} }],
    ['an unknown origin', { headers: { origin: 'https://evil.example' } }],
    ['the opaque "null" origin', { headers: { origin: 'null' } }],
    ['a prefix of an allowed origin', { headers: { origin: 'https://billing.example.com.evil.example' } }],
    ['an allowed host on the wrong scheme', { headers: { origin: 'http://billing.example.com' } }],
    ['an allowed origin with a trailing slash', { headers: { origin: 'https://billing.example.com/' } }],
  ])('refuses %s with 403', (_label, request) => {
    const guard = buildGuard();
    expect(() => guard.canActivate(contextWith(request))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextWith(request))).toThrow(ORIGIN_NOT_ALLOWED);
  });

  it('never reads a portal from the body or query', () => {
    const request: Record<string, unknown> = {
      headers: {},
      body: { portal: 'billing' },
      query: { portal: 'billing' },
    };
    expect(() => buildGuard().canActivate(contextWith(request))).toThrow(ForbiddenException);
  });

  it('lets a @NoPortal() route through with no origin, and assigns none', () => {
    const request: Record<string, unknown> = { headers: {} };
    expect(buildGuard(true).canActivate(contextWith(request))).toBe(true);
    expect(request.portal).toBeUndefined();
  });
});

describe('PortalOrigins', () => {
  it('refuses to construct from a bad map', () => {
    expect(() => new PortalOrigins(new ConfigService({ AUTH_PORTAL_ORIGINS: 'x' }))).toThrow();
  });

  it('lists the origins for CORS', () => {
    const origins = new PortalOrigins(new ConfigService({ AUTH_PORTAL_ORIGINS: ORIGINS }));
    expect(origins.origins()).toEqual(['https://billing.example.com', 'https://studio.example.com']);
  });
});
