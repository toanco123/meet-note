import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination/cursor.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
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
}
