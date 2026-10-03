import { isPortal, parsePortalOrigins } from './portal';

describe('parsePortalOrigins', () => {
  it('maps each origin to its portal', () => {
    const map = parsePortalOrigins('https://billing.example.com=billing,https://studio.example.com=studio');
    expect([...map]).toEqual([
      ['https://billing.example.com', 'billing'],
      ['https://studio.example.com', 'studio'],
    ]);
  });

  it('allows several origins for one portal, e.g. two local dev ports', () => {
    const map = parsePortalOrigins('http://localhost:5173=billing, http://localhost:5182=billing');
    expect(map.get('http://localhost:5173')).toBe('billing');
    expect(map.get('http://localhost:5182')).toBe('billing');
  });

  it('normalises host case and a default port, the way browsers send Origin', () => {
    const map = parsePortalOrigins('https://Billing.Example.com:443=billing');
    expect([...map.keys()]).toEqual(['https://billing.example.com']);
  });

  it('ignores a trailing comma', () => {
    expect(parsePortalOrigins('https://a.example=billing,').size).toBe(1);
  });

  it.each([
    ['unset', undefined, /at least one/],
    ['empty', '', /at least one/],
    ['missing =', 'https://a.example', /origin=portal/],
    ['unknown portal', 'https://a.example=admin', /not a portal/],
    ['a path', 'https://a.example/app=billing', /origin only/],
    ['a trailing slash', 'https://a.example/=billing', /origin only/],
    ['a query', 'https://a.example?x=1=billing', /origin only/],
    ['not a URL', 'billing.example.com=billing', /not a URL/],
    ['a non-http scheme', 'ftp://a.example=billing', /http or https/],
    ['a duplicate', 'https://a.example=billing,https://A.example=studio', /listed twice/],
  ])('refuses %s, at boot', (_label, value, message) => {
    expect(() => parsePortalOrigins(value)).toThrow(message);
  });
});

describe('isPortal', () => {
  it('knows exactly the two portals', () => {
    expect(isPortal('billing')).toBe(true);
    expect(isPortal('studio')).toBe(true);
    expect(isPortal('admin')).toBe(false);
    expect(isPortal(undefined)).toBe(false);
  });
});
