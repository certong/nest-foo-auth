import { requireAuthSchema } from './prisma.service';

const BASE = 'postgresql://user:s3cret@host-pooler.region.aws.neon.tech/foo_platform';

describe('requireAuthSchema', () => {
  it('accepts a URL that selects schema auth, and returns it unchanged', () => {
    const url = `${BASE}?sslmode=require&channel_binding=require&schema=auth`;
    expect(requireAuthSchema(url)).toBe(url);
    expect(requireAuthSchema(`${BASE}?schema=auth`)).toBe(`${BASE}?schema=auth`);
  });

  it('refuses a URL with no schema parameter, which Prisma would read as public', () => {
    expect(() => requireAuthSchema(`${BASE}?sslmode=require`)).toThrow(/no schema parameter/);
    expect(() => requireAuthSchema(BASE)).toThrow(/no schema parameter/);
  });

  it('refuses schema=auth joined with a second "?", which is swallowed into sslmode', () => {
    expect(() => requireAuthSchema(`${BASE}?sslmode=require?schema=auth`)).toThrow(/no schema parameter/);
  });

  it('refuses another schema by name', () => {
    expect(() => requireAuthSchema(`${BASE}?schema=billing`)).toThrow(/schema=billing/);
    expect(() => requireAuthSchema(`${BASE}?schema=public`)).toThrow(/schema=public/);
  });

  it('refuses a missing or unparseable URL', () => {
    expect(() => requireAuthSchema(undefined)).toThrow(/not set/);
    expect(() => requireAuthSchema('')).toThrow(/not set/);
    expect(() => requireAuthSchema('not a url')).toThrow(/not a URL/);
  });

  it('never puts the password in the message', () => {
    for (const url of [BASE, `${BASE}?schema=billing`, `${BASE}?sslmode=require?schema=auth`]) {
      let message = '';
      try {
        requireAuthSchema(url);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('s3cret');
    }
  });
});
