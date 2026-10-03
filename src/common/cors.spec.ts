import { DEFAULT_CORS_MAX_AGE_SECONDS, corsOptions } from './cors';

const ORIGINS = ['https://billing.example.com', 'https://studio.example.com'];

describe('corsOptions', () => {
  describe('the origin allowlist', () => {
    it('is exactly the portal origins', () => {
      expect(corsOptions(ORIGINS).origin).toEqual(ORIGINS);
    });

    it('is a copy, so a later change to the source list cannot widen it', () => {
      const source = [...ORIGINS];
      const options = corsOptions(source);
      source.push('https://evil.example');
      expect(options.origin).toEqual(ORIGINS);
    });

    it('is a list, never a wildcard or a reflect-anything flag', () => {
      const { origin } = corsOptions(ORIGINS);
      expect(Array.isArray(origin)).toBe(true);
      expect(origin).not.toContain('*');
    });
  });

  describe('the preflight cache (CP-43)', () => {
    it('sets a max age so a preflight is not repeated per request', () => {
      expect(corsOptions(ORIGINS).maxAge).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
    });

    it('takes the max age from configuration', () => {
      expect(corsOptions(ORIGINS, '30').maxAge).toBe(30);
    });

    it.each(['', 'ten', '-1', '0'])('falls back to the default rather than trusting %o', (value) => {
      expect(corsOptions(ORIGINS, value).maxAge).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
    });
  });

  describe('the rest of the policy, which must not move', () => {
    const options = corsOptions(ORIGINS);

    it('sends credentials, since the refresh cookie rides on them', () => {
      expect(options.credentials).toBe(true);
    });

    it('allows exactly the methods this service answers', () => {
      expect(options.methods).toEqual(['GET', 'POST', 'OPTIONS']);
    });

    it('allows exactly Content-Type and Authorization', () => {
      expect(options.allowedHeaders).toEqual(['Content-Type', 'Authorization']);
    });
  });
});
