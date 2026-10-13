import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** Vai trò có thể gán qua API. `owner` không nằm ở đây: đổi owner = chuyển quyền sở hữu (M3). */
export const ASSIGNABLE_ORG_ROLES = ['admin', 'member'] as const;
export type AssignableOrgRole = (typeof ASSIGNABLE_ORG_ROLES)[number];

export class UpdateMemberRoleDto {
  @IsIn(ASSIGNABLE_ORG_ROLES)
  @ApiProperty({ enum: ASSIGNABLE_ORG_ROLES, enumName: 'AssignableOrgRole', example: 'admin' })
  role: AssignableOrgRole;
}
