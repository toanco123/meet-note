import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppException } from '../../../../src/common/errors/app.exception.js';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { organizationMembers } from '../../../../src/infra/database/schema/index.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/repositories/organization-members.repository.js';
import { OrganizationMembersService } from '../../../../src/modules/organizations/services/organization-members.service.js';
import { addMember, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (error as AppException).code ?? String(error);
  }
}

/**
 * Race: Owner nâng B lên admin SONG SONG với Admin A gỡ B.
 * Ma trận: Admin chỉ gỡ được Member → hai thao tác KHÔNG BAO GIỜ được cùng thành công.
 *
 * Không khoá: A đọc thấy B là member (được gỡ), Owner nâng B, A xoá B → admin bị admin gỡ.
 * Có khoá (actor, target) theo user_id + kiểm tra lại: thao tác sau thấy trạng thái mới →
 *   - nâng trước: A thấy B là admin → 403 FORBIDDEN
 *   - gỡ trước:   Owner không thấy B → 404 NOT_FOUND
 */
const VALID_OUTCOMES = ['OK/FORBIDDEN/admin', 'NOT_FOUND/OK/gone'];

describe('Race: đổi vai trò vs gỡ cùng một thành viên (Postgres thật)', () => {
  let t: TestDb;
  let service: OrganizationMembersService;

  beforeAll(async () => {
    t = createTestDb(20);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationMembersService,
        OrganizationMembersRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(OrganizationMembersService);
  });

  afterAll(async () => {
    await t.close();
  });

  it('Owner nâng B ‖ Admin gỡ B → không bao giờ cả hai cùng OK (20 vòng)', async () => {
    const owner = await insertUser(t.db);
    const admin = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, admin.id, 'admin');
    const seen = new Set<string>();

    for (let round = 0; round < 20; round++) {
      const b = await insertUser(t.db);
      await addMember(t.db, org.id, b.id, 'member');

      const [promote, removal] = await Promise.all([
        outcomeOf(service.changeRole(org.id, b.id, 'admin', { actorId: owner.id })),
        outcomeOf(service.remove(org.id, b.id, { actorId: admin.id })),
      ]);

      const [row] = await t.db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, b.id)));

      // Gộp "kết quả 2 thao tác + trạng thái cuối của B trong DB" thành một chuỗi. Chỉ 2 chuỗi hợp lệ:
      //   OK/FORBIDDEN/admin   — nâng trước, gỡ sau thấy B là admin
      //   NOT_FOUND/OK/gone    — gỡ trước, nâng sau không thấy B
      // Không khoá sẽ thấy OK/OK/gone (admin bị admin gỡ).
      const actual = `${promote}/${removal}/${row?.role ?? 'gone'}`;
      expect(VALID_OUTCOMES, `vòng ${round}`).toContain(actual);
      seen.add(actual);
    }

    // Không bắt buộc, nhưng giúp thấy cả hai thứ tự đều đã xảy ra trong lượt chạy này.
    console.info('Các kết cục đã gặp:', [...seen]);
  });
});
