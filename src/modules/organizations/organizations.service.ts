import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { OrgRole } from './organization.policy.js';
import {
  type MyOrganizationRow,
  type OrganizationDetailRow,
  OrganizationsRepository,
} from './organizations.repository.js';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: OrganizationsRepository,
  ) {}

  /**
   * Org và Owner đầu tiên phải cùng tồn tại: org không có owner là trạng thái hỏng (không ai
   * quản trị được), nên hai INSERT nằm chung một transaction.
   */
  async create(userId: string, name: string): Promise<MyOrganizationRow> {
    return this.db.transaction(async (tx) => {
      const org = await this.repo.insertOrganization(name, userId, tx);
      const owner = await this.repo.insertMember(
        { orgId: org.id, userId, role: OrgRole.Owner },
        tx,
      );
      return { id: org.id, name: org.name, role: owner.role, joinedAt: owner.joinedAt };
    });
  }

  listMine(userId: string): Promise<MyOrganizationRow[]> {
    return this.repo.listForUser(userId);
  }

  async getDetail(orgId: string): Promise<OrganizationDetailRow> {
    const detail = await this.repo.findDetail(orgId);
    // Guard đã xác nhận membership; tới đây mà không thấy nghĩa là org vừa bị xoá giữa chừng.
    if (!detail) throw AppException.notFound('Không tìm thấy tổ chức.');
    return detail;
  }

  async rename(orgId: string, name: string): Promise<OrganizationDetailRow> {
    if (!(await this.repo.updateName(orgId, name))) {
      throw AppException.notFound('Không tìm thấy tổ chức.');
    }
    return this.getDetail(orgId);
  }
}
