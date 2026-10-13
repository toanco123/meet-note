import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../../common/swagger/api-error-responses.decorator.js';
import type { OrgPermission } from '../organization.policy.js';
import { OrgMemberGuard } from './org-member.guard.js';
import { ORG_PERMISSION_KEY, OrgPermissionGuard } from './org-permission.guard.js';

/**
 * Một decorator cho mọi route có `:orgId`:
 *   `@RequireOrgPermission('org.member.remove')`
 *
 * Gộp sẵn THỨ TỰ guard (thành viên → quyền) nên không thể quên `OrgMemberGuard` hay đặt ngược.
 * Permission key có kiểu union → gõ sai là lỗi compile. Kèm luôn tài liệu Swagger cho 403/404.
 */
export function RequireOrgPermission(permission: OrgPermission) {
  return applyDecorators(
    SetMetadata(ORG_PERMISSION_KEY, permission),
    UseGuards(OrgMemberGuard, OrgPermissionGuard),
    ApiParam({ name: 'orgId', format: 'uuid', description: 'Id tổ chức' }),
    ApiErrorResponses(401, 403, 404),
  );
}
