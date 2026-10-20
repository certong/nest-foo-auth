import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertNoDuplicateEnvKeys, findDuplicateKeys } from './env-file';

const dir = mkdtempSync(join(tmpdir(), 'env-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function envFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('findDuplicateKeys', () => {
  it('finds nothing in a file that assigns each key once', () => {
    expect(findDuplicateKeys('APP_ENV=local\nPORT=3001\nDATABASE_URL="postgresql://x"')).toEqual([]);
  });

  it('names a repeated key and every line it is on', () => {
    const contents = ['APP_ENV=local', 'DATABASE_URL=one', 'PORT=3001', 'DATABASE_URL=two'].join('\n');
    expect(findDuplicateKeys(contents)).toEqual([{ key: 'DATABASE_URL', lines: [2, 4] }]);
  });

  it('reports the real incident: a local block followed by a second pair', () => {
    // The shape of the .env found on 2026-10-19, which read as local and
    // resolved to Neon dev.
    const contents = [
      'APP_ENV=local',
      'DATABASE_URL="postgresql://root:x@localhost:5432/foo_auth_local?schema=auth"',
      'DIRECT_URL="postgresql://root:x@localhost:5432/foo_auth_local?schema=auth"',
      'DATABASE_URL="postgresql://app:y@ep-dev-pooler.neon.tech/foo_platform?schema=billing"',
      'DIRECT_URL="postgresql://app:y@ep-dev.neon.tech/foo_platform?schema=billing"',
    ].join('\n');

    expect(findDuplicateKeys(contents)).toEqual([
      { key: 'DATABASE_URL', lines: [2, 4] },
      { key: 'DIRECT_URL', lines: [3, 5] },
    ]);
  });

  it('ignores commented-out alternates, which are not definitions', () => {
    const contents = ['DATABASE_URL=one', '# DATABASE_URL=two', '   # DATABASE_URL=three'].join('\n');
    expect(findDuplicateKeys(contents)).toEqual([]);
  });

  it('counts an exported assignment as the same key', () => {
    expect(findDuplicateKeys('PORT=3001\nexport PORT=3002')).toEqual([{ key: 'PORT', lines: [1, 2] }]);
  });

  it('reads a KEY= inside a multi-line quoted value as part of the value', () => {
    // Without this the signing key, which is JSON, could invent a duplicate
    // out of its own contents and refuse a boot for nothing.
    const contents = ['AUTH_SIGNING_JWK="{', '  PORT=not-a-key', '}"', 'PORT=3001'].join('\n');
    expect(findDuplicateKeys(contents)).toEqual([]);
  });

  it('still sees a duplicate after a multi-line value has closed', () => {
    const contents = ['AUTH_SIGNING_JWK="{', '  x', '}"', 'PORT=3001', 'PORT=3002'].join('\n');
    expect(findDuplicateKeys(contents)).toEqual([{ key: 'PORT', lines: [4, 5] }]);
  });

  it('is not fooled by an escaped quote inside a value', () => {
    expect(findDuplicateKeys('A="say \\"hi\\""\nB=2')).toEqual([]);
  });

  it('handles CRLF, which is how these files arrive on Windows', () => {
    expect(findDuplicateKeys('PORT=3001\r\nPORT=3002\r\n')).toEqual([{ key: 'PORT', lines: [1, 2] }]);
  });

  it('reports several repeated keys in the order they first appear', () => {
    const contents = ['B=1', 'A=1', 'B=2', 'A=2'].join('\n');
    expect(findDuplicateKeys(contents).map((d) => d.key)).toEqual(['B', 'A']);
  });
});

describe('assertNoDuplicateEnvKeys', () => {
  it('says nothing about a file that is fine', () => {
    const path = envFile('ok.env', 'APP_ENV=local\nPORT=3001\n');
    expect(() => assertNoDuplicateEnvKeys(path)).not.toThrow();
  });

  it('is silent when there is no .env at all, as in a deployment', () => {
    expect(() => assertNoDuplicateEnvKeys(join(dir, 'absent.env'))).not.toThrow();
  });

  it('names the key and the lines', () => {
    const path = envFile('dupe.env', 'DATABASE_URL=one\nPORT=3001\nDATABASE_URL=two\n');
    expect(() => assertNoDuplicateEnvKeys(path)).toThrow(/DATABASE_URL \(lines 1, 3\)/);
  });

  it('never puts a value in the message, because they carry passwords', () => {
    const path = envFile('secret.env', 'DATABASE_URL=postgresql://u:hunter2@a/b\nDATABASE_URL=postgresql://u:hunter2@c/d\n');
    try {
      assertNoDuplicateEnvKeys(path);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });
});
