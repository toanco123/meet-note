import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../../../common/errors/errors.js';
import { isUuid } from '../../../common/validation/uuid.js';
import { OrganizationsRepository } from '../repositories/organizations.repository.js';
import { OrgContext } from '../../../infra/database/org-context.js';

/**
 * Tầng 2 của phân quyền: người gọi có phải thành viên org `:orgId` không?
 *
 * - Không phải thành viên / org đã xoá → 404 (không lộ org có tồn tại hay không).
 * - BẪY: guard chạy TRƯỚC pipe, nên `ParseUUIDPipe` trên `:orgId` chưa chạy. Chuỗi rác đưa
 *   xuống Postgres sẽ thành lỗi 22P02 (invalid uuid) → 500. Phải tự kiểm tra định dạng ở đây.
 * - Chạy sau `JwtAuthGuard` (guard toàn cục luôn chạy trước guard của route) → đã có `req.user`.
 */
@Injectable()
export class OrgMemberGuard implements CanActivate {
  constructor(private readonly repo: OrganizationsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) throw new Error('OrgMemberGuard cần JwtAuthGuard chạy trước (route @Public?)');

    const orgId = request.params['orgId'];
    if (!isUuid(orgId)) throw Errors.org.notFound();

    const membership = await this.repo.findMembership(orgId, user.id);
    if (!membership) throw Errors.org.notFound();

    request.orgMembership = { orgId, role: membership.role };
    // RLS (M11 B7): từ đây mọi connection request này mượn đều mang `app.org_id` = tổ chức trên path
    // — CHỈ sau khi đã xác nhận là thành viên (ngữ cảnh không bao giờ trỏ vào tổ chức người lạ).
    OrgContext.enter(orgId);
    return true;
  }
}
