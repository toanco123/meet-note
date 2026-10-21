import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  channelMembers,
  channels,
  organizationMembers,
} from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import type { ChannelAccess } from '../../../../src/modules/channels/channels.types.js';
import { ChannelMembersRepository } from '../../../../src/modules/channels/repositories/channel-members.repository.js';
import { ChannelsRepository } from '../../../../src/modules/channels/repositories/channels.repository.js';
import { ChannelMembersService } from '../../../../src/modules/channels/services/channel-members.service.js';
import { ChannelsService } from '../../../../src/modules/channels/services/channels.service.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/repositories/organization-members.repository.js';
import { OrganizationMembersService } from '../../../../src/modules/organizations/services/organization-members.service.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertOrg,
  insertUser,
} from '../../../support/db-factories.js';
import { realtimeStub } from '../../../support/realtime-stub.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { interleave, runWhileLocked } from '../../../support/locks.js';

/**
 * Race phải chặn của M4 (Q3): Admin GỠ X khỏi org ‖ Chủ kênh CHUYỂN kênh cho X.
 * Không phối hợp khoá: gỡ kiểm tra "X không làm chủ kênh nào" → chuyển commit → gỡ xoá X →
 * cascade xoá dòng chủ kênh → KÊNH MẤT CHỦ.
 *
 * Chặn bằng thứ tự khoá chung: chuyển chủ kênh khoá `FOR SHARE` dòng org của NGƯỜI NHẬN (bậc 1),
 * gỡ khoá `FOR UPDATE` cùng dòng → tuần tự. Ép cả HAI thứ tự, mỗi thứ tự một đột biến làm đỏ.
 */
describe('Race: gỡ X khỏi org ‖ chuyển chủ kênh cho X (Postgres thật)', () => {
  let t: TestDb;
  let orgMembersService: OrganizationMembersService;
  let channelMembersService: ChannelMembersService;

  beforeAll(async () => {
    t = createTestDb(6);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationMembersService,
        OrganizationMembersRepository,
        ChannelMembersService,
        ChannelMembersRepository,
        ChannelsService,
        ChannelsRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
        realtimeStub,
      ],
    }).compile();
    orgMembersService = moduleRef.get(OrganizationMembersService);
    channelMembersService = moduleRef.get(ChannelMembersService);
  });

  afterAll(async () => {
    await t.close();
  });

  async function setup() {
    const orgOwner = await insertUser(t.db);
    const org = await insertOrg(t.db, orgOwner.id);
    const [admin, co, x] = [await insertUser(t.db), await insertUser(t.db), await insertUser(t.db)];
    await addMember(t.db, org.id, admin.id, 'admin');
    await addMember(t.db, org.id, co.id, 'member');
    await addMember(t.db, org.id, x.id, 'member');
    const channel = await insertChannel(t.db, org.id, co.id);
    await addChannelMember(t.db, channel, org.id, x.id, 'member');
    const coAccess: ChannelAccess = {
      orgId: org.id,
      userId: co.id,
      orgRole: 'member',
      channelRole: 'owner',
      channel: { id: channel.id, visibility: 'public', archivedAt: null },
    };
    const orgRowOf = (userId: string) =>
      and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, userId));
    return { org, admin, co, x, channel, coAccess, orgRowOf };
  }

  const ownersOf = async (channelId: string) =>
    (
      await t.db
        .select({ userId: channelMembers.userId })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.role, 'owner')))
    )
      .map((r) => r.userId)
      .join();

  // Đột biến: chuyển chủ kênh bỏ khoá dòng org của NGƯỜI NHẬN → không đợi, commit X làm chủ;
  // rồi gỡ xoá X → cascade xoá dòng chủ → 'OK/OK/' (kênh mất chủ).
  it('GỠ TRƯỚC: chuyển chủ kênh đợi dòng org của X → X đã bị gỡ → 404; kênh giữ chủ cũ', async () => {
    const { co, x, channel, coAccess, orgRowOf } = await setup();

    const { holder, contender } = await interleave(t.db, {
      // Gỡ: khoá dòng org của X, kiểm tra X không làm chủ kênh nào (đúng tại thời điểm này)…
      hold: (tx) => tx.select().from(organizationMembers).where(orgRowOf(x.id)).for('update'),
      contend: () => channelMembersService.transferOwnership(coAccess, x.id, { actorId: co.id }),
      // …rồi xoá X (cascade xoá X khỏi mọi kênh).
      afterWait: (tx) => tx.delete(organizationMembers).where(orgRowOf(x.id)),
    });

    expect(`${holder}/${contender}/${await ownersOf(channel.id)}`).toBe(`OK/NOT_FOUND/${co.id}`);
  });

  // Đột biến: `remove` bỏ kiểm tra "còn làm chủ kênh" → 'OK/' (gỡ được, kênh mất chủ).
  it('CHUYỂN TRƯỚC: gỡ đợi dòng org của X → thấy X đã là chủ kênh → 409; X vẫn là chủ', async () => {
    const { org, admin, co, x, channel, orgRowOf } = await setup();
    const row = (userId: string) =>
      and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, userId));

    const outcome = await runWhileLocked(
      t.db,
      // Chuyển chủ kênh theo đúng thứ tự khoá: org của X (FOR SHARE) → kênh → hạ CO, nâng X.
      async (tx) => {
        await tx.select().from(organizationMembers).where(orgRowOf(x.id)).for('share');
        await tx.select().from(channels).where(eq(channels.id, channel.id)).for('update');
        await tx.update(channelMembers).set({ role: 'admin' }).where(row(co.id));
        await tx.update(channelMembers).set({ role: 'owner' }).where(row(x.id));
      },
      () => orgMembersService.remove(org.id, x.id, { actorId: admin.id }),
    );

    expect(`${outcome}/${await ownersOf(channel.id)}`).toBe(`ORG_MEMBER_OWNS_CHANNELS/${x.id}`);
  });
});
