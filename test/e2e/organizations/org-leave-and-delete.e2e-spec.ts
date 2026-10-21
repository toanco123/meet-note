import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { auditLogs } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { addChannelMember, addMember } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

describe('Tổ chức: rời / gỡ khi còn làm chủ kênh, xoá tổ chức (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);

  /** Org mới: owner, orgAdmin, alice (chủ 2 kênh), bob (thành viên 2 kênh đó). */
  async function setup() {
    const [owner, orgAdmin, alice, bob] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    const orgId: string = (
      await http().post('/v1/orgs').set(as(owner)).send({ name: 'Rời & xoá' }).expect(201)
    ).body.data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    await addMember(db, orgId, alice.id, 'member');
    await addMember(db, orgId, bob.id, 'member');
    const channels: Array<{ id: string; name: string }> = [];
    for (const name of ['Kỹ thuật', 'Bán hàng']) {
      const res = await http()
        .post(`/v1/orgs/${orgId}/channels`)
        .set(as(alice))
        .send({ name })
        .expect(201);
      const channel = { id: res.body.data.id as string, name };
      await addChannelMember(db, channel, orgId, bob.id, 'member');
      channels.push(channel);
    }
    return { orgId, owner, orgAdmin, alice, bob, channels };
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Rời / bị gỡ khi còn làm chủ kênh', () => {
    it('chủ kênh rời org → 409 ORG_MEMBER_OWNS_CHANNELS, details liệt kê kênh (A→Z)', async () => {
      const { orgId, alice, channels } = await setup();

      const res = await http().post(`/v1/orgs/${orgId}/leave`).set(as(alice)).expect(409);

      const [kyThuat, banHang] = channels;
      expect(res.body.error).toMatchObject({
        code: 'ORG_MEMBER_OWNS_CHANNELS',
        statusCode: 409,
        details: [
          { field: `channels.${banHang?.id}`, message: 'Bán hàng' },
          { field: `channels.${kyThuat?.id}`, message: 'Kỹ thuật' },
        ],
      });
    });

    it('Admin gỡ chủ kênh → 409; OrgAdm chuyển hộ các kênh → gỡ được (204)', async () => {
      const { orgId, orgAdmin, alice, bob, channels } = await setup();
      const removeAlice = () =>
        http().delete(`/v1/orgs/${orgId}/members/${alice.id}`).set(as(orgAdmin));

      const blocked = await removeAlice().expect(409);
      expect(blocked.body.error.code).toBe('ORG_MEMBER_OWNS_CHANNELS');

      for (const channel of channels) {
        await http()
          .post(`/v1/orgs/${orgId}/channels/${channel.id}/ownership-transfer`)
          .set(as(orgAdmin))
          .send({ newOwnerId: bob.id })
          .expect(200);
      }
      await removeAlice().expect(204);
    });

    it('chuyển chủ hết kênh rồi thì tự rời được', async () => {
      const { orgId, alice, bob, channels } = await setup();
      for (const channel of channels) {
        await http()
          .post(`/v1/orgs/${orgId}/channels/${channel.id}/ownership-transfer`)
          .set(as(alice))
          .send({ newOwnerId: bob.id })
          .expect(200);
      }
      const res = await http().post(`/v1/orgs/${orgId}/leave`).set(as(alice));
      expect(res.status).toBe(204);
    });

    it('kênh đã xoá mềm không chặn việc rời org', async () => {
      const { orgId, alice, channels } = await setup();
      for (const channel of channels) {
        await http().delete(`/v1/orgs/${orgId}/channels/${channel.id}`).set(as(alice)).expect(204);
      }
      const res = await http().post(`/v1/orgs/${orgId}/leave`).set(as(alice));
      expect(res.status).toBe(204);
    });
  });

  describe('DELETE /v1/orgs/:orgId', () => {
    it.each([
      ['Admin', 403, 'orgAdmin'],
      ['thành viên', 403, 'bob'],
    ] as const)('%s xoá org → %i', async (_label, status, who) => {
      const ctx = await setup();
      const res = await http().delete(`/v1/orgs/${ctx.orgId}`).set(as(ctx[who]));
      expect(res.status).toBe(status);
    });

    it('Owner xoá → 204; mọi route bên trong 404 với mọi người; link mời hết dùng được; có audit', async () => {
      const { orgId, owner, alice, channels } = await setup();
      const invite = await http()
        .post(`/v1/orgs/${orgId}/invites`)
        .set(as(owner))
        .send({})
        .expect(201);

      await http().delete(`/v1/orgs/${orgId}`).set(as(owner)).expect(204);

      const statuses = await Promise.all([
        http().get(`/v1/orgs/${orgId}`).set(as(owner)),
        http().get(`/v1/orgs/${orgId}/members`).set(as(owner)),
        http().get(`/v1/orgs/${orgId}/channels/${channels[0]?.id}`).set(as(alice)),
        http().delete(`/v1/orgs/${orgId}`).set(as(owner)),
      ]);
      expect(statuses.map((r) => r.status)).toEqual([404, 404, 404, 404]);

      const mine = await http().get('/v1/orgs').set(as(owner)).expect(200);
      expect(mine.body.data.map((o: { id: string }) => o.id)).not.toContain(orgId);

      const preview = await http().get(`/v1/invites/${invite.body.data.token}`);
      expect(preview.body.error?.code).toBe('INVITE_NOT_FOUND');

      const logs = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'org.deleted')));
      expect(logs).toHaveLength(1);
    });
  });
});
