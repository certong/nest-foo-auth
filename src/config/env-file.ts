import { existsSync, readFileSync } from 'node:fs';

/**
 * Refuses a .env that defines the same key twice.
 *
 * dotenv keeps the LAST value of a repeated key and says nothing, so a file
 * can read as one thing and mean another. That is not hypothetical here: the
 * .env found in this repo on 2026-10-19 declared APP_ENV=local above a local
 * DATABASE_URL and then repeated DATABASE_URL and DIRECT_URL pointing at Neon
 * dev with schema=billing. The service refused to boot — but only because
 * requireAuthSchema rejects a URL without schema=auth, which is luck rather
 * than a rule, and `prisma migrate deploy` has no such guard at all.
 *
 * There is one .env now and editing it is the way to change targets, so this
 * is the check that the edit landed where it was meant to.
 */
export interface DuplicateKey {
  key: string;
  /** 1-based, so the message can be pasted into an editor's go-to-line. */
  lines: number[];
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Every key the file assigns more than once, in the order they first appear.
 *
 * Quoted values that run over several lines are consumed whole rather than
 * scanned, so a KEY=... inside one is a value and not a definition. Without
 * that, a multi-line secret could invent a duplicate out of its own contents
 * and refuse a boot for nothing.
 */
export function findDuplicateKeys(contents: string): DuplicateKey[] {
  const lines = contents.replace(/^﻿/, '').split(/\r?\n/);
  const seen = new Map<string, number[]>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    seen.set(key!, [...(seen.get(key!) ?? []), i + 1]);

    // A value opening with a quote that does not close on this line runs on.
    const value = rawValue!.trimStart();
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : null;
    if (quote !== null && !closesOn(value.slice(1), quote)) {
      while (i + 1 < lines.length && !closesOn(lines[i + 1]!, quote)) {
        i += 1;
      }
      i += 1;
    }
  }

  return [...seen.entries()].filter(([, at]) => at.length > 1).map(([key, lines]) => ({ key, lines }));
}

/** An unescaped closing quote somewhere in the rest of the line. */
function closesOn(rest: string, quote: string): boolean {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '\\') {
      i += 1;
      continue;
    }
    if (rest[i] === quote) {
      return true;
    }
  }
  return false;
}

/**
 * Throws if `path` repeats a key. A missing file is not an error: deployments
 * take their configuration from the platform's environment and have no .env.
 *
 * Names the keys and the lines, never the values — a repeated key is most
 * likely a DATABASE_URL, and those carry passwords.
 */
export function assertNoDuplicateEnvKeys(path = '.env'): void {
  if (!existsSync(path)) {
    return;
  }
  const duplicates = findDuplicateKeys(readFileSync(path, 'utf8'));
  if (duplicates.length === 0) {
    return;
  }
  const detail = duplicates.map(({ key, lines }) => `${key} (lines ${lines.join(', ')})`).join('; ');
  throw new Error(
    `${path} defines the same key more than once: ${detail}. ` +
      'dotenv keeps the last one, so the file does not mean what it appears to. ' +
      'Delete the earlier definitions, and keep alternates in a file of their own ' +
      'rather than commented out inside this one (see .env.example).',
  );
}
