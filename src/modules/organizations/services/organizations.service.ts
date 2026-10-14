import { Inject, Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/errors.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import { diffForAudit, isEmptyDiff } from '../../audit/audit-diff.js';
import { AuditService } from '../../audit/audit.service.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import type { Database } from '../../../infra/database/database.types.js';
import { OrgRole } from '../organization.policy.js';
import { OrganizationsRepository } from '../repositories/organizations.repository.js';
import type {
  MyOrganizationRow,
  OrganizationDetailRow,
  OrganizationPatch,
} from '../organizations.types.js';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: OrganizationsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Org, Owner đầu tiên và dòng audit phải cùng tồn tại hoặc cùng không: org không có owner là
   * trạng thái hỏng; thao tác không có audit là lỗ hổng truy vết.
   */
  async create(name: string, ctx: UserAuditContext): Promise<MyOrganizationRow> {
    return this.db.transaction(async (tx) => {
      const org = await this.repo.insertOrganization(name, ctx.actorId, tx);
      const owner = await this.repo.insertMember(
        { orgId: org.id, userId: ctx.actorId, role: OrgRole.Owner },
        tx,
      );
      await this.audit.record(tx, ctx, {
        orgId: org.id,
        action: 'org.created',
        targetType: 'organization',
        targetId: org.id,
        metadata: { after: { name: org.name } },
      });
      return { id: org.id, name: org.name, role: owner.role, joinedAt: owner.joinedAt };
    });
  }

  listMine(userId: string): Promise<MyOrganizationRow[]> {
    return this.repo.listForUser(userId);
  }

  async getDetail(orgId: string): Promise<OrganizationDetailRow> {
    const detail = await this.repo.findDetail(orgId);
    // Guard đã xác nhận membership; tới đây mà không thấy nghĩa là org vừa bị xoá giữa chừng.
    if (!detail) throw Errors.org.notFound();
    return detail;
  }

  /** Khoá dòng org → đọc giá trị cũ → ghi → audit `{ before, after }` (chỉ field thực sự đổi). */
  async update(
    orgId: string,
    patch: OrganizationPatch,
    ctx: UserAuditContext,
  ): Promise<OrganizationDetailRow> {
    await this.db.transaction(async (tx) => {
      const current = await this.repo.lockForUpdate(orgId, tx);
      if (!current) throw Errors.org.notFound();

      const changed = diffForAudit(current, patch);
      if (isEmptyDiff(changed)) return; // không đổi gì → không ghi, không log

      await this.repo.update(orgId, changed.after, tx);
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.updated',
        targetType: 'organization',
        targetId: orgId,
        metadata: changed,
      });
    });
    return this.getDetail(orgId);
  }
}
