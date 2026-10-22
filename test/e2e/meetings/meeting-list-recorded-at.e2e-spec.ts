import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { meetingShares } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser } from '../../support/factories.js';

/**
 * `meeting_shares.recorded_at` là BẢN CHÉP (M11 B5): share ghi lúc tạo, sửa `recordedAt` cập nhật
 * cùng transaction. Người xem chỉ thấy meeting QUA kênh (k = 1 < K = 2 kênh → luồng "theo từng
 * kênh" sắp theo cột chép) → bản chép cũ = thứ tự sai.
 */
describe('Danh sách meeting theo bản chép recorded_at (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  // Đột biến: `MeetingsRepository.update` không cập nhật share → thứ tự vẫn như cũ (đỏ).
  it('share chép recorded_at; sửa recordedAt → share cập nhật và thứ tự danh sách của người xem qua kênh đổi theo', async () => {
    const [owner, author, viewer] = [
      await registerUser(app),
      await registerUser(app),
      await registerUser(app),
    ];
    const orgId = (
      await request(app.getHttpServer())
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Chép' })
        .expect(201)
    ).body.data.id as string;
    for (const u of [author, viewer]) await addMember(db, orgId, u.id);
    const channel = await insertChannel(db, orgId, owner.id, { visibility: 'private' });
    await insertChannel(db, orgId, owner.id, { visibility: 'private' }); // K = 2
    for (const u of [author, viewer]) await addChannelMember(db, channel, orgId, u.id, 'member');
    const first = await insertMeeting(db, orgId, author.id, {
      recordedAt: new Date('2026-01-01T09:00:00Z'),
    });
    const second = await insertMeeting(db, orgId, author.id, {
      recordedAt: new Date('2026-01-02T09:00:00Z'),
    });
    for (const m of [first, second]) {
      await request(app.getHttpServer())
        .post(`/v1/orgs/${orgId}/meetings/${m.id}/shares`)
        .set(bearer(author.tokens.accessToken))
        .send({ channelId: channel.id })
        .expect(201);
    }
    const list = async () =>
      (
        (
          await request(app.getHttpServer())
            .get(`/v1/orgs/${orgId}/meetings`)
            .set(bearer(viewer.tokens.accessToken))
            .expect(200)
        ).body.data as Array<{ id: string }>
      ).map((m) => m.id);
    const copied = async () =>
      (
        await db.select().from(meetingShares).where(eq(meetingShares.meetingId, first.id))
      )[0]?.recordedAt.toISOString();

    const before = [await list(), await copied()];
    await request(app.getHttpServer())
      .patch(`/v1/orgs/${orgId}/meetings/${first.id}`)
      .set(bearer(author.tokens.accessToken))
      .send({ recordedAt: '2026-01-03T09:00:00Z' })
      .expect(200);

    expect([before, [await list(), await copied()]]).toEqual([
      [[second.id, first.id], '2026-01-01T09:00:00.000Z'],
      [[first.id, second.id], '2026-01-03T09:00:00.000Z'],
    ]);
  });
});
