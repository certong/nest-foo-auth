import { HttpStatus } from '@nestjs/common';
import { PORTAL_ACCESS, PORTAL_DENIED, canEnter, isAccountType, portalDenied } from './account-type';

describe('PORTAL_ACCESS', () => {
  it.each([
    ['staff', 'billing', true],
    ['staff', 'studio', true],
    ['client', 'billing', false],
    ['client', 'studio', true],
  ] as const)('%s at %s: %s', (type, portal, allowed) => {
    expect(canEnter(type, portal)).toBe(allowed);
  });

  it('names every account type', () => {
    expect(Object.keys(PORTAL_ACCESS).sort()).toEqual(['client', 'staff']);
  });
});

describe('isAccountType', () => {
  it('knows exactly the two types', () => {
    expect(isAccountType('staff')).toBe(true);
    expect(isAccountType('client')).toBe(true);
    expect(isAccountType('admin')).toBe(false);
    expect(isAccountType(undefined)).toBe(false);
  });
});

describe('portalDenied', () => {
  it('is a 403 with a message that does not read as a wrong password', () => {
    const error = portalDenied();
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.message).toBe(PORTAL_DENIED);
  });
});
