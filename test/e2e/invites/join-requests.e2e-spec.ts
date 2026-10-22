import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { createTestApp } from '../../support/app.js';
import { addMember } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { fixtureDb } from '../../support/db.js';

describe('Yêu cầu tham gia: bật duyệt → chấp nhận link → duyệt / từ chối (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, admin, member] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Duyệt' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  /** Người mới chấp nhận một link (vai trò tuỳ chọn) → trả requestId đang chờ. */
  async function pendingRequest(role: 'admin' | 'member' = 'member') {
    const {
      body: { data: invite },
    } = await http().post(`/v1/orgs/${orgId}/invites`).set(as(owner)).send({ role }).expect(201);
    const guest = await registerUser(app, { displayName: `Khách ${role}` });
    const res = await http().post(`/v1/invites/${invite.token}/accept`).set(as(guest)).expect(200);
    expect(res.body.data.status).toBe('pending');
    return { guest, requestId: res.body.data.requestId as string };
  }

  it('bật requireJoinApproval: Admin được (200), Member bị 403', async () => {
    await http()
      .patch(`/v1/orgs/${orgId}`)
      .set(as(member))
      .send({ requireJoinApproval: true })
      .expect(403);
    const res = await http()
      .patch(`/v1/orgs/${orgId}`)
      .set(as(admin))
      .send({ requireJoinApproval: true })
      .expect(200);
    expect(res.body.data.requireJoinApproval).toBe(true);
  });

  it('Admin thấy yêu cầu đang chờ (kèm tên/email người xin), duyệt → người đó vào org', async () => {
    const { guest, requestId } = await pendingRequest();

    const list = await http().get(`/v1/orgs/${orgId}/join-requests`).set(as(admin)).expect(200);
    expect(list.body.data).toContainEqual(
      expect.objectContaining({
        id: requestId,
        userId: guest.id,
        displayName: 'Khách member',
        status: 'pending',
      }),
    );

    const approved = await http()
      .post(`/v1/orgs/${orgId}/join-requests/${requestId}/approve`)
      .set(as(admin))
      .expect(200);
    expect(approved.body.data).toEqual({ id: requestId, status: 'approved' });
    const org = await http().get(`/v1/orgs/${orgId}`).set(as(guest)).expect(200);
    expect(org.body.data.myRole).toBe('member');
  });

  it('duyệt lần hai → 409 JOIN_REQUEST_NOT_PENDING', async () => {
    const { requestId } = await pendingRequest();
    const approve = () =>
      http().post(`/v1/orgs/${orgId}/join-requests/${requestId}/approve`).set(as(owner));
    expect((await approve()).status).toBe(200);
    const again = await approve().expect(409);
    expect(again.body.error.code).toBe('JOIN_REQUEST_NOT_PENDING');
  });

  it('yêu cầu vào với vai trò admin: Admin duyệt → 403, Owner duyệt → 200 (vai trò admin)', async () => {
    const { guest, requestId } = await pendingRequest('admin');

    const byAdmin = await http()
      .post(`/v1/orgs/${orgId}/join-requests/${requestId}/approve`)
      .set(as(admin))
      .expect(403);
    expect(byAdmin.body.error.code).toBe('FORBIDDEN');

    await http()
      .post(`/v1/orgs/${orgId}/join-requests/${requestId}/approve`)
      .set(as(owner))
      .expect(200);
    const org = await http().get(`/v1/orgs/${orgId}`).set(as(guest)).expect(200);
    expect(org.body.data.myRole).toBe('admin');
  });

  it('từ chối → người đó KHÔNG vào org, và có thể gửi yêu cầu mới bằng link khác', async () => {
    const { guest, requestId } = await pendingRequest();

    const rejected = await http()
      .post(`/v1/orgs/${orgId}/join-requests/${requestId}/reject`)
      .set(as(admin))
      .expect(200);
    expect(rejected.body.data.status).toBe('rejected');
    await http().get(`/v1/orgs/${orgId}`).set(as(guest)).expect(404);

    const {
      body: { data: invite },
    } = await http().post(`/v1/orgs/${orgId}/invites`).set(as(owner)).send({}).expect(201);
    const retry = await http()
      .post(`/v1/invites/${invite.token}/accept`)
      .set(as(guest))
      .expect(200);
    expect(retry.body.data.status).toBe('pending');
  });

  it('lọc status=rejected chỉ trả yêu cầu đã từ chối', async () => {
    const res = await http()
      .get(`/v1/orgs/${orgId}/join-requests`)
      .query({ status: 'rejected' })
      .set(as(owner))
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(new Set(res.body.data.map((r: { status: string }) => r.status))).toEqual(
      new Set(['rejected']),
    );
  });

  it('member xem danh sách yêu cầu → 403', async () => {
    const res = await http().get(`/v1/orgs/${orgId}/join-requests`).set(as(member)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
