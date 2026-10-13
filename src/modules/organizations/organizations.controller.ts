import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto/organization-name.dto.js';
import {
  MyOrganizationResponseDto,
  OrganizationResponseDto,
} from './dto/organization-response.dto.js';
import { CurrentOrgMembership } from './guards/org-membership.js';
import { RequireOrgPermission } from './guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from './organization.policy.js';
import { OrganizationsService } from './organizations.service.js';

@ApiTags('Organizations')
@Controller('orgs')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  /** Tạo tổ chức. Người tạo trở thành Owner. */
  @Post()
  @ApiErrorResponses(400, 401)
  async create(
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: CreateOrganizationDto,
  ): Promise<MyOrganizationResponseDto> {
    return MyOrganizationResponseDto.from(await this.orgs.create(dto.name, audit));
  }

  /**
   * Các tổ chức tôi là thành viên.
   *
   * @remarks Không phân trang: một người thuộc ít tổ chức.
   */
  @Get()
  @ApiErrorResponses(401)
  async listMine(@CurrentUser() user: AuthUser): Promise<MyOrganizationResponseDto[]> {
    return (await this.orgs.listMine(user.id)).map((row) => MyOrganizationResponseDto.from(row));
  }

  /**
   * Chi tiết tổ chức.
   *
   * @remarks Không phải thành viên → 404 (không cho biết tổ chức có tồn tại hay không).
   */
  @Get(':orgId')
  @RequireOrgPermission('org.read')
  async get(
    @Param('orgId') orgId: string,
    @CurrentOrgMembership() membership: OrgMembershipContext,
  ): Promise<OrganizationResponseDto> {
    return OrganizationResponseDto.from(await this.orgs.getDetail(orgId), membership.role);
  }

  /** Đổi tên tổ chức (Admin trở lên). */
  @Patch(':orgId')
  @RequireOrgPermission('org.update')
  @ApiErrorResponses(400)
  async rename(
    @Param('orgId') orgId: string,
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    return OrganizationResponseDto.from(
      await this.orgs.update(
        orgId,
        { name: dto.name, requireJoinApproval: dto.requireJoinApproval },
        audit,
      ),
      membership.role,
    );
  }
}
