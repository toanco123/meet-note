import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import type { Transaction } from '../../../../src/infra/database/database.types.js';
import {
  auditLogs,
  channelMembers,
  channels,
  organizationMembers,
} from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { ChannelMembersRepository } from '../../../../src/modules/channels/repositories/channel-members.repository.js';
import { ChannelMembersService } from '../../../../src/modules/channels/services/channel-members.service.js';
import { ChannelsRepository } from '../../../../src/modules/channels/repositories/channels.repository.js';
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
import { lockChannelThen, outcomeOf, runWhileLocked } from '../../../support/locks.js';
import type { ChannelAccess } from '../../../../src/modules/channels/channels.types.js';

/**
 * Các race của B4. Hai cái đầu ép thứ tự bằng `runWhileLocked` (T1 giữ khoá, T2 đợi rồi đọc lại);
 * cái cuối là song song thật. Mỗi test ghi chú ĐỘT BIẾN làm nó đỏ (kết quả trong plan M4).
 */
describe('Race: thành viên kênh (Postgres thật)', () => {
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
        realtimeStub,
      ],
    }).compile();
    service = moduleRef.get(ChannelMembersService);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Kênh do `co` làm chủ + một thành viên org `target` (chưa ở trong kênh). */
  async function setup() {
    const co = await insertUser(t.db);
    const org = await insertOrg(t.db, co.id);
    const channel = await insertChannel(t.db, org.id, co.id);
    const target = await insertUser(t.db);
    await addMember(t.db, org.id, target.id, 'member');
    // Ảnh chụp guard đã thấy trước khi T1 chạy.
    const access: ChannelAccess = {
      orgId: org.id,
      userId: co.id,
      orgRole: 'owner',
      channelRole: 'owner',
      channel: { id: channel.id, visibility: 'public', archivedAt: null },
    };
    return { org, channel, target, access, ctx: { actorId: co.id } };
  }

  const roleOf = async (channelId: string, userId: string) =>
    (
      await t.db
        .select({ role: channelMembers.role })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    )[0]?.role ?? 'gone';

  /** T1 giống "gỡ X khỏi tổ chức" (B7): khoá dòng org của X rồi xoá → cascade xoá X khỏi mọi kênh. */
  const removeFromOrg = (orgId: string, userId: string) => async (tx: Transaction) => {
    const where = and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId));
    await tx.select().from(organizationMembers).where(where).for('update');
    await tx.delete(organizationMembers).where(where);
  };

  // Đột biến: bỏ `lockForAction` (khoá + kiểm tra lại) trong `add` → 'OK', người được thêm vào kênh lưu trữ.
  it('lưu trữ kênh ‖ thêm thành viên → 409 CHANNEL_ARCHIVED, không ai được thêm', async () => {
    const { channel, target, access, ctx } = await setup();

    const outcome = await runWhileLocked(
      t.db,
      lockChannelThen(channel.id, (tx) =>
        tx.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channel.id)),
      ),
      () => service.add(access, target.id, 'member', ctx),
    );

    expect(`${outcome}/${await roleOf(channel.id, target.id)}`).toBe('CHANNEL_ARCHIVED/gone');
  });

  // Đột biến: bỏ `lockRoleForShare` → INSERT đợi ở bước kiểm tra FK, rồi nổ 23503 (lỗi Postgres lọt ra).
  it('gỡ X khỏi tổ chức ‖ thêm X vào kênh → 404, không phải lỗi FK', async () => {
    const { org, channel, target, access, ctx } = await setup();

    const outcome = await runWhileLocked(t.db, removeFromOrg(org.id, target.id), () =>
      service.add(access, target.id, 'member', ctx),
    );

    expect(`${outcome}/${await roleOf(channel.id, target.id)}`).toBe('NOT_FOUND/gone');
  });

  // Đột biến: `lockMember` bỏ `.for('update')` → đọc thấy dòng cũ, UPDATE trúng 0 dòng mà không báo,
  // VẪN ghi audit "đã đổi vai trò" cho một thay đổi không hề xảy ra.
  it('gỡ X khỏi tổ chức ‖ đổi vai trò kênh của X → 404 và KHÔNG có audit ma', async () => {
    const { org, channel, target, access, ctx } = await setup();
    await addChannelMember(t.db, channel, org.id, target.id, 'member');

    const outcome = await runWhileLocked(t.db, removeFromOrg(org.id, target.id), () =>
      service.changeRole(access, target.id, 'guest', ctx),
    );

    const ghostLogs = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetId, channel.id),
          eq(auditLogs.action, 'channel.member.role_changed'),
        ),
      );
    expect(`${outcome}/${ghostLogs.length}`).toBe('NOT_FOUND/0');
  });

  it('2 QTV cùng thêm một người song song → đúng 1 OK, 1 CHANNEL_ALREADY_MEMBER', async () => {
    const { channel, target, access, ctx } = await setup();

    const outcomes = await Promise.all([
      outcomeOf(service.add(access, target.id, 'member', ctx)),
      outcomeOf(service.add(access, target.id, 'guest', ctx)),
    ]);

    expect(outcomes.sort()).toEqual(['CHANNEL_ALREADY_MEMBER', 'OK']);
    expect(['member', 'guest']).toContain(await roleOf(channel.id, target.id));
  });
});
