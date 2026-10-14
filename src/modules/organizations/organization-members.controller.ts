import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination/cursor.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto.js';
import { ListMembersQueryDto } from './dto/list-members-query.dto.js';
import { MemberResponseDto } from './dto/member-response.dto.js';
import { RequireOrgPermission } from './guards/require-org-permission.decorator.js';
import { OrganizationMembersService } from './organization-members.service.js';

@ApiTags('Organizations')
@Controller('orgs/:orgId/members')
export class OrganizationMembersController {
  constructor(private readonly members: OrganizationMembersService) {}

  /**
   * Danh sách thành viên.
   *
   * @remarks Phân trang cursor theo thời điểm tham gia. `q` tìm không dấu theo tên/email.
   */
  @Get()
  @RequireOrgPermission('org.member.list')
  @ApiPaginatedResponse(MemberResponseDto)
  @ApiErrorResponses(400)
  list(
    @Param('orgId') orgId: string,
    @Query() query: ListMembersQueryDto,
  ): Promise<Page<MemberResponseDto>> {
    return this.members.list(orgId, query);
  }

  /**
   * Đổi vai trò member ↔ admin (chỉ Owner).
   *
   * @remarks Đổi vai trò của Owner → 409 `ORG_OWNER_IMMUTABLE` (dùng chuyển quyền sở hữu).
   */
  @Patch(':userId')
  @RequireOrgPermission('org.member.role.change')
  @ApiErrorResponses(400, 409)
  changeRole(
    @Param('orgId') orgId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: UpdateMemberRoleDto,
  ): Promise<MemberResponseDto> {
    return this.members.changeRole(orgId, userId, dto.role, audit);
  }

  /**
   * Gỡ thành viên khỏi tổ chức.
   *
   * @remarks Owner gỡ được Admin/Member; Admin chỉ gỡ được Member. Gỡ Owner → 409. Rời tổ chức
   * (tự gỡ mình) là chức năng riêng ở M3.
   */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireOrgPermission('org.member.remove')
  @ApiNoContentResponse({ description: 'Đã gỡ thành viên.' })
  @ApiErrorResponses(400, 409)
  async remove(
    @Param('orgId') orgId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<void> {
    await this.members.remove(orgId, userId, audit);
  }
}
