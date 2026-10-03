import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuthEventRetention,
  DEFAULT_RETENTION_DAYS,
  pruneAuthEvents,
  retentionCutoff,
  retentionDays,
} from './auth-event-retention';

/** A fake $executeRaw that deletes from a pretend table of `rows` old rows. */
function fakeTable(rows: number) {
  let remaining = rows;
  const calls: { sql: string; values: unknown[] }[] = [];
  const $executeRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values });
    const limit = values[1] as number;
    const deleted = Math.min(limit, remaining);
    remaining -= deleted;
    return Promise.resolve(deleted);
  });
  return { prisma: { $executeRaw } as unknown as PrismaService, calls, remaining: () => remaining };
}

describe('retentionDays', () => {
  it('defaults to a year', () => {
    expect(retentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(retentionDays('')).toBe(365);
  });

  it('reads a configured value', () => {
    expect(retentionDays('400')).toBe(400);
  });

  it.each(['0', '-1', '1.5', 'a year', 'NaN'])('refuses %o at boot', (value) => {
    expect(() => retentionDays(value)).toThrow(/AUTH_EVENT_RETENTION_DAYS/);
  });
});

describe('retentionCutoff', () => {
  it('is that many days before now', () => {
    expect(retentionCutoff(365, new Date('2027-10-03T00:00:00Z')).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
});

describe('pruneAuthEvents', () => {
  const cutoff = new Date('2025-10-03T00:00:00Z');

  it('deletes in batches until a batch comes back short, and reports the total', async () => {
    const table = fakeTable(12);
    await expect(pruneAuthEvents(table.prisma, cutoff, 5)).resolves.toBe(12);
    expect(table.calls).toHaveLength(3); // 5, 5, 2
    expect(table.remaining()).toBe(0);
  });

  it('runs one extra, empty batch when the count is an exact multiple', async () => {
    const table = fakeTable(10);
    await expect(pruneAuthEvents(table.prisma, cutoff, 5)).resolves.toBe(10);
    expect(table.calls).toHaveLength(3); // 5, 5, 0
  });

  it('names the schema itself and binds the cutoff as a parameter', async () => {
    const table = fakeTable(0);
    await pruneAuthEvents(table.prisma, cutoff, 5);
    expect(table.calls[0].sql).toContain('auth.auth_event');
    expect(table.calls[0].values[0]).toBe(cutoff);
  });
});

describe('AuthEventRetention', () => {
  it('never throws out of a sweep', async () => {
    const prisma = { $executeRaw: vi.fn().mockRejectedValue(new Error('down')) } as unknown as PrismaService;
    const retention = new AuthEventRetention(prisma, new ConfigService({}));
    await expect(retention.sweep()).resolves.toBe(0);
  });

  it('refuses to construct with a bad retention value', () => {
    expect(() => new AuthEventRetention({} as PrismaService, new ConfigService({ AUTH_EVENT_RETENTION_DAYS: '0' }))).toThrow();
  });

  it('clears its timers on shutdown', () => {
    const retention = new AuthEventRetention({} as PrismaService, new ConfigService({}));
    retention.onApplicationBootstrap();
    retention.onModuleDestroy();
    expect((retention as unknown as { timers: unknown[] }).timers).toHaveLength(0);
  });
});
