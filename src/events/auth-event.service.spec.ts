import { PrismaService } from '../prisma/prisma.service';
import { AuthEventService, USER_AGENT_MAX_LENGTH } from './auth-event.service';

function buildService(createMany = vi.fn().mockResolvedValue({ count: 1 })) {
  const prisma = { authEvent: { createMany } } as unknown as PrismaService;
  return { service: new AuthEventService(prisma), createMany };
}

describe('AuthEventService.record', () => {
  it('inserts every event in one statement, ignoring duplicates', async () => {
    // skipDuplicates is ON CONFLICT DO NOTHING — what turns the second
    // portal_entry for a (sid, portal) into a no-op against the partial index.
    const { service, createMany } = buildService();

    await service.record([
      { kind: 'login_success', portal: 'billing', accountId: 'acc', method: 'password', sid: 'sid' },
      { kind: 'portal_entry', portal: 'billing', accountId: 'acc', sid: 'sid' },
    ]);

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(createMany.mock.calls[0][0].data).toEqual([
      { kind: 'login_success', portal: 'billing', accountId: 'acc', method: 'password', sid: 'sid', ip: null, userAgent: null },
      { kind: 'portal_entry', portal: 'billing', accountId: 'acc', method: null, sid: 'sid', ip: null, userAgent: null },
    ]);
  });

  it('writes nothing for an empty list', async () => {
    const { service, createMany } = buildService();
    await service.record([]);
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each(['203.0.113.7', '::1', '::ffff:203.0.113.7', '2001:db8::1'])('keeps a valid IP %s', async (ip) => {
    const { service, createMany } = buildService();
    await service.record([{ kind: 'login_failed', portal: 'billing', ip }]);
    expect(createMany.mock.calls[0][0].data[0].ip).toBe(ip);
  });

  it.each(['', 'unknown', '203.0.113.7, 10.0.0.1', '999.1.1.1'])(
    'drops an IP inet would refuse (%o) instead of losing the event',
    async (ip) => {
      const { service, createMany } = buildService();
      await service.record([{ kind: 'login_failed', portal: 'billing', ip }]);
      expect(createMany.mock.calls[0][0].data[0].ip).toBeNull();
    },
  );

  it('cuts a long user agent to the column width', async () => {
    const { service, createMany } = buildService();
    await service.record([{ kind: 'login_failed', portal: 'billing', userAgent: 'x'.repeat(2000) }]);
    expect(createMany.mock.calls[0][0].data[0].userAgent).toHaveLength(USER_AGENT_MAX_LENGTH);
  });

  it('swallows a failed insert, so the log can never change a sign-in answer', async () => {
    const { service } = buildService(vi.fn().mockRejectedValue(new Error('connection reset')));
    await expect(service.record([{ kind: 'login_failed', portal: 'billing' }])).resolves.toBeUndefined();
  });
});
