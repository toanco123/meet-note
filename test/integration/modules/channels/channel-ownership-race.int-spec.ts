import { Test } from '@nestjs/testing';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  channelMembers,
  organizationMembers,
} from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import type { ChannelAccess } from '../../../../src/modules/channels/channels.types.js';
import { ChannelMembersRepository } from '../../../../src/modules/channels/repositories/channel-members.repository.js';
import { ChannelsRepository } from '../../../../src/modules/channels/repositories/channels.repository.js';
import { ChannelMembersService } from '../../../../src/modules/channels/services/channel-members.service.js';
import { ChannelsService } from '../../../../src/modules/channels/services/channels.service.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/repositories/organization-members.repository.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertOrg,
  insertUser,
} from '../../../support/db-factories.js';
import { realtimeStub } from '../../../support/realtime-stub.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { interleave, lockChannelThen, outcomeOf, runWhileLocked } from '../../../support/locks.js';

/**
 * Race của chuyển chủ kênh / rời kênh (B5). Mỗi test ghi chú ĐỘT BIẾN làm nó đỏ (kết quả trong plan M4).
 */
describe('Race: chuyển chủ kênh (Postgres thật)', () => {
  let t: TestDb;
  let service: ChannelMembersService;

  beforeAll(async () => {
    t = createTestDb(6);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChannelMembersService,
        ChannelMembersRepository,
        ChannelsService,
        ChannelsRepository,
        OrganizationMembersRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
        NotificationsService,
        NotificationsRepository,
        realtimeStub,
      ],
    }).compile();
    service = moduleRef.get(ChannelMembersService);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Org có Owner riêng; `co` là THÀNH VIÊN org (không có quyền override) và là Chủ kênh. */
  async function setup() {
    const orgOwner = await insertUser(t.db);
    const org = await insertOrg(t.db, orgOwner.id);
    const [co, x, y] = [await insertUser(t.db), await insertUser(t.db), await insertUser(t.db)];
    for (const u of [co, x, y]) await addMember(t.db, org.id, u.id, 'member');
    const channel = await insertChannel(t.db, org.id, co.id);
    await addChannelMember(t.db, channel, org.id, x.id, 'member');
    await addChannelMember(t.db, channel, org.id, y.id, 'member');
    const accessOf = (userId: string, channelRole: 'owner' | 'member'): ChannelAccess => ({
      orgId: org.id,
      userId,
      orgRole: 'member',
      channelRole,
      channel: { id: channel.id, visibility: 'public', archivedAt: null },
    });
    return { org, channel, co, x, y, accessOf };
  }

  const ownersOf = async (channelId: string) =>
    (
      await t.db
        .select({ userId: channelMembers.userId })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.role, 'owner')))
    ).map((r) => r.userId);

  /**
   * DEADLOCK nếu khoá sai thứ tự. T1 = "gỡ X khỏi org": khoá dòng org của X, rồi xoá → cascade
   * xoá X khỏi kênh → cần khoá dòng `channel_members` của X.
   *
   *   Đúng (org → kênh → thành viên kênh): T2 đợi ngay ở dòng org của X, CHƯA giữ gì của kênh →
   *     T1 xoá xong, commit → T2 thấy X không còn trong org → 404. Không vòng.
   *   Đột biến (kênh → thành viên kênh → org): T2 đã giữ dòng `channel_members` của X rồi mới đợi
   *     dòng org của X; T1 giữ dòng org và cascade đợi dòng `channel_members` → VÒNG → Postgres
   *     giết một bên sau `deadlock_timeout` (1 giây) với `40P01`.
   */
  it('gỡ X khỏi org ‖ chuyển chủ kênh cho X → không deadlock: gỡ OK, chuyển 404', async () => {
    const { org, channel, co, x, accessOf } = await setup();
    const orgRowOfX = and(
      eq(organizationMembers.orgId, org.id),
      eq(organizationMembers.userId, x.id),
    );

    const { holder, contender } = await interleave(t.db, {
      hold: (tx) => tx.select().from(organizationMembers).where(orgRowOfX).for('update'),
      contend: () => service.transferOwnership(accessOf(co.id, 'owner'), x.id, { actorId: co.id }),
      afterWait: (tx) => tx.delete(organizationMembers).where(orgRowOfX),
    });

    expect(`${holder}/${contender}`).toBe('OK/NOT_FOUND');
    expect(await ownersOf(channel.id)).toEqual([co.id]);
  });

  // Đột biến: `leave` đọc vai trò mà không khoá (bỏ `lockForAction` + `FOR UPDATE`) → đọc thấy
  // 'member' cũ, DELETE đợi rồi xoá luôn dòng vừa thành CHỦ → kênh mất chủ ('OK/').
  it('CO chuyển cho X ‖ X rời kênh → X đã thành chủ thì không rời được (409), kênh luôn có chủ', async () => {
    const { channel, co, x, accessOf } = await setup();

    const outcome = await runWhileLocked(
      t.db,
      lockChannelThen(channel.id, async (tx) => {
        const row = (userId: string) =>
          and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, userId));
        await tx.update(channelMembers).set({ role: 'admin' }).where(row(co.id));
        await tx.update(channelMembers).set({ role: 'owner' }).where(row(x.id));
      }),
      () => service.leave(accessOf(x.id, 'member'), { actorId: x.id }),
    );

    expect(`${outcome}/${(await ownersOf(channel.id)).join()}`).toBe(
      `CHANNEL_OWNER_MUST_TRANSFER/${x.id}`,
    );
  });

  it('CO chuyển cho X và cho Y SONG SONG → đúng 1 thành công, kênh có đúng 1 chủ', async () => {
    const { channel, co, x, y, accessOf } = await setup();
    const access = accessOf(co.id, 'owner');

    const outcomes = await Promise.all([
      outcomeOf(service.transferOwnership(access, x.id, { actorId: co.id })),
      outcomeOf(service.transferOwnership(access, y.id, { actorId: co.id })),
    ]);

    // Lần sau đọc lại vai trò sau khi khoá: CO đã thành QTV, không phải OrgAdm → 403.
    expect(outcomes.sort()).toEqual(['FORBIDDEN', 'OK']);
    const owners = await ownersOf(channel.id);
    expect(owners).toHaveLength(1);
    expect([x.id, y.id]).toContain(owners[0]);
  });
});
