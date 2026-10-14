import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Errors } from '../../../common/errors/errors.js';
import { type OrgPermission, orgPolicy } from '../organization.policy.js';

export const ORG_PERMISSION_KEY = 'meetnote:orgPermission';

/**
 * Tầng 3: vai trò hiện tại có được làm LOẠI hành động này không (hỏi policy thuần).
 * Kiểm tra theo đối tượng cụ thể (Admin gỡ Admin…) KHÔNG nằm ở đây mà ở service, sau khi khoá dòng.
 */
@Injectable()
export class OrgPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.get<OrgPermission | undefined>(
      ORG_PERMISSION_KEY,
      context.getHandler(),
    );
    const membership = context.switchToHttp().getRequest<Request>().orgMembership;
    if (!permission || !membership) {
      // Lỗi cấu hình của lập trình viên, không phải của client → 500 để lộ ra sớm khi test.
      throw new Error(
        'OrgPermissionGuard thiếu permission hoặc membership — dùng @RequireOrgPermission()',
      );
    }

    if (!orgPolicy[permission](membership)) {
      throw Errors.org.forbidden();
    }
    return true;
  }
}
