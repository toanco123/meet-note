import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { channelMembers, channels } from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { ChannelsRepository } from '../../../../src/modules/channels/repositories/channels.repository.js';
import { ChannelsService } from '../../../../src/modules/channels/services/channels.service.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertOrg,
  insertUser,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { lockChannelThen, runWhileLocked } from '../../../support/locks.js';
import type { ChannelAccess } from '../../../../src/modules/channels/channels.types.js';

/**
 * Guard đọc quyền + trạng thái kênh TRƯỚC khi service khoá dòng kênh. Ở giữa, một thao tác khác
 * (lưu trữ — B6, hạ vai trò — B4) có thể đã đổi mọi thứ. Thứ tự ép bằng tay:
 *
 *   T1: khoá dòng kênh → đổi trạng thái ─────────────── (giữ khoá) ──── COMMIT
 *   T2:                     service.update → khoá dòng kênh … ĐỢI … ──────────── → đọc lại → ?
 *
 * Có kiểm tra lại sau khoá → T2 thấy dữ liệu MỚI và từ chối. Bỏ kiểm tra → T2 ghi đè lên kênh đã
 * lưu trữ / bằng quyền đã mất (đột biến này làm 2 test đầu đỏ — xem plan M4).
 */
describe('Race: sửa kênh ‖ thay đổi đồng thời trên kênh đó (Postgres thật)', () => {
  let t: TestDb;
  let service: ChannelsService;

  beforeAll(async () => {
    t = createTestDb(5);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChannelsService,
        ChannelsRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(ChannelsService);
  });

  afterAll(async () => {
    await t.close();
  });

  async function setup() {
    const owner = await insertUser(t.db);
    const qtv = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, qtv.id, 'member');
    const channel = await insertChannel(t.db, org.id, owner.id);
    await addChannelMember(t.db, channel, org.id, qtv.id, 'admin');
    // Ảnh chụp guard đã thấy: kênh đang hoạt động, qtv là QTV kênh → guard cho qua.
    const access: ChannelAccess = {
      orgId: org.id,
      userId: qtv.id,
      orgRole: 'member',
      channelRole: 'admin',
      channel: { id: channel.id, visibility: 'public', archivedAt: null },
    };
    return { channel, qtv, access };
  }

  const nameOf = async (channelId: string) =>
    (await t.db.select({ name: channels.name }).from(channels).where(eq(channels.id, channelId)))[0]
      ?.name;

  it('kênh bị lưu trữ trong lúc QTV đang sửa → 409 CHANNEL_ARCHIVED, tên giữ nguyên', async () => {
    const { channel, qtv, access } = await setup();

    const outcome = await runWhileLocked(
      t.db,
      lockChannelThen(channel.id, (tx) =>
        tx.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channel.id)),
      ),
      () => service.update(access, { name: 'Tên mới' }, { actorId: qtv.id }),
    );

    expect(outcome).toBe('CHANNEL_ARCHIVED');
    expect(await nameOf(channel.id)).toBe(channel.name);
  });

  it('QTV bị hạ xuống thành viên trong lúc đang sửa → 403 FORBIDDEN, tên giữ nguyên', async () => {
    const { channel, qtv, access } = await setup();

    const outcome = await runWhileLocked(
      t.db,
      lockChannelThen(channel.id, (tx) =>
        tx
          .update(channelMembers)
          .set({ role: 'member' })
          .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, qtv.id))),
      ),
      () => service.update(access, { name: 'Tên mới' }, { actorId: qtv.id }),
    );

    expect(outcome).toBe('FORBIDDEN');
    expect(await nameOf(channel.id)).toBe(channel.name);
  });

  it('đối chứng: T1 không đổi gì → T2 đợi khoá rồi sửa thành công', async () => {
    const { channel, qtv, access } = await setup();

    const outcome = await runWhileLocked(
      t.db,
      lockChannelThen(channel.id, async () => undefined),
      () => service.update(access, { name: 'Tên mới' }, { actorId: qtv.id }),
    );

    expect(outcome).toBe('OK');
    expect(await nameOf(channel.id)).toBe('Tên mới');
  });
});
