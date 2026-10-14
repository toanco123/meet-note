import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import {
  ApiErrorResponses,
  type DocumentedErrorStatus,
} from '../../../common/swagger/api-error-responses.decorator.js';
import { OrgMemberGuard } from '../../organizations/guards/org-member.guard.js';
import { BLOCKED_WHEN_ARCHIVED, type ChannelPermission } from '../channel.policy.js';
import { ChannelAccessGuard } from './channel-access.guard.js';
import { CHANNEL_PERMISSION_KEY, ChannelPermissionGuard } from './channel-permission.guard.js';

/**
 * Một decorator cho mọi route có `:channelId`: `@RequireChannelPermission('channel.update')`.
 * Gộp sẵn THỨ TỰ guard: thành viên org → thấy được kênh → quyền. Không thể quên hay đặt ngược.
 * Permission bị chặn khi lưu trữ thì Swagger tự có thêm 409.
 */
export function RequireChannelPermission(permission: ChannelPermission) {
  const errors: DocumentedErrorStatus[] = [401, 403, 404];
  if (BLOCKED_WHEN_ARCHIVED.has(permission)) errors.push(409);
  return applyDecorators(
    SetMetadata(CHANNEL_PERMISSION_KEY, permission),
    UseGuards(OrgMemberGuard, ChannelAccessGuard, ChannelPermissionGuard),
    ApiParam({ name: 'orgId', format: 'uuid', description: 'Id tổ chức' }),
    ApiParam({ name: 'channelId', format: 'uuid', description: 'Id kênh' }),
    ApiErrorResponses(...errors),
  );
}
