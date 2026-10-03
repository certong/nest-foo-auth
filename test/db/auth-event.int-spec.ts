import { randomUUID } from 'node:crypto';
import { AuthEventService } from '../../src/events/auth-event.service';
import { pruneAuthEvents } from '../../src/events/auth-event-retention';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ThrowawayDatabase, createThrowawayDatabase, HAS_DATABASE } from './throwaway-database';

let db: ThrowawayDatabase;
let events: AuthEventService;

describe.skipIf(!HAS_DATABASE)('auth_event against Postgres', () => {
  beforeAll(async () => {
    db = await createThrowawayDatabase();
    events = new AuthEventService(db.prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.prisma.authEvent.deleteMany();
  });

  const entries = (sid: string) =>
    db.prisma.authEvent.findMany({ where: { sid, kind: 'portal_entry' }, orderBy: { id: 'asc' } });

  describe('one portal_entry per (sid, portal)', () => {
    it('keeps the first and ignores every repeat, through the service the app uses', async () => {
      const sid = randomUUID();
      for (let i = 0; i < 5; i += 1) {
        await events.record([{ kind: 'portal_entry', portal: 'billing', sid, accountId: randomUUID() }]);
      }
      expect(await entries(sid)).toHaveLength(1);
    });

    it('lets a second portal in once', async () => {
      const sid = randomUUID();
      await events.record([{ kind: 'portal_entry', portal: 'billing', sid }]);
      await events.record([{ kind: 'portal_entry', portal: 'studio', sid }]);
      await events.record([{ kind: 'portal_entry', portal: 'studio', sid }]);

      expect((await entries(sid)).map((e) => e.portal)).toEqual(['billing', 'studio']);
    });

    it('treats a repeat inside one batch the same as across batches', async () => {
      const sid = randomUUID();
      await events.record([
        { kind: 'login_success', portal: 'billing', sid, method: 'password' },
        { kind: 'portal_entry', portal: 'billing', sid },
        { kind: 'portal_entry', portal: 'billing', sid },
      ]);
      expect(await entries(sid)).toHaveLength(1);
      expect(await db.prisma.authEvent.count({ where: { sid } })).toBe(2);
    });

    it('says nothing about other kinds: logouts and failures repeat freely', async () => {
      const sid = randomUUID();
      await events.record([{ kind: 'logout', portal: 'billing', sid }]);
      await events.record([{ kind: 'logout', portal: 'billing', sid }]);
      for (let i = 0; i < 3; i += 1) {
        await events.record([{ kind: 'login_failed', portal: 'billing', method: 'password' }]);
      }
      expect(await db.prisma.authEvent.count({ where: { kind: 'logout' } })).toBe(2);
      expect(await db.prisma.authEvent.count({ where: { kind: 'login_failed' } })).toBe(3);
    });

    it('holds under concurrent refreshes', async () => {
      const sid = randomUUID();
      await Promise.all(
        Array.from({ length: 10 }, () => events.record([{ kind: 'portal_entry', portal: 'studio', sid }])),
      );
      expect(await entries(sid)).toHaveLength(1);
    });
  });

  describe('the CHECK constraints', () => {
    // Straight to Prisma, not through the service, which would swallow the error.
    it.each([
      [{ kind: 'nonsense', portal: 'billing' }],
      [{ kind: 'login_failed', portal: 'admin' }],
      [{ kind: 'login_failed', portal: 'billing', method: 'sms' }],
    ])('refuses %o', async (row) => {
      await expect(db.prisma.authEvent.create({ data: row })).rejects.toThrow();
    });

    it('stores IPv4, IPv6 and mapped addresses as inet', async () => {
      await events.record(
        ['203.0.113.7', '2001:db8::1', '::ffff:203.0.113.7'].map((ip) => ({ kind: 'login_failed' as const, portal: 'billing' as const, ip })),
      );
      expect((await db.prisma.authEvent.findMany({ orderBy: { id: 'asc' } })).map((e) => e.ip)).toEqual([
        '203.0.113.7',
        '2001:db8::1',
        '::ffff:203.0.113.7',
      ]);
    });
  });

  describe('retention', () => {
    it('deletes only rows older than the cutoff, across several batches', async () => {
      const old = new Date('2024-01-01T00:00:00Z');
      const recent = new Date();
      await db.prisma.authEvent.createMany({
        data: [
          ...Array.from({ length: 23 }, () => ({ kind: 'login_failed', portal: 'billing', createdAt: old })),
          ...Array.from({ length: 4 }, () => ({ kind: 'login_failed', portal: 'billing', createdAt: recent })),
        ],
      });

      const deleted = await pruneAuthEvents(db.prisma, new Date('2025-01-01T00:00:00Z'), 5);

      expect(deleted).toBe(23);
      expect(await db.prisma.authEvent.count()).toBe(4);
    });
  });
});
