import { ExecutionContext } from '@nestjs/common';
import { JsonContentTypeGuard } from './json-content-type.guard';

function contextFor(method: string, contentType?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, headers: contentType ? { 'content-type': contentType } : {} }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const guard = new JsonContentTypeGuard();

describe('JsonContentTypeGuard', () => {
  it('lets a GET through whatever it declares', () => {
    expect(guard.canActivate(contextFor('GET'))).toBe(true);
  });

  it.each(['application/json', 'application/json; charset=utf-8'])(
    'accepts %s on a mutating request',
    (contentType) => {
      expect(guard.canActivate(contextFor('POST', contentType))).toBe(true);
    },
  );

  it.each(['text/plain', 'application/x-www-form-urlencoded', undefined])(
    'refuses %s, which a cross-site form can send',
    (contentType) => {
      expect(() => guard.canActivate(contextFor('POST', contentType))).toThrow(
        /Content-Type must be application\/json/,
      );
    },
  );

  it('refuses multipart, which a cross-site form can also send and this service never accepts', () => {
    expect(() =>
      guard.canActivate(contextFor('POST', 'multipart/form-data; boundary=----abc123')),
    ).toThrow(/Content-Type must be application\/json/);
  });
});
