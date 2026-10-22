import { Throttle } from '@nestjs/throttler';
import { RateLimit } from '../../../infra/rate-limit/rate-limits.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import { ApiErrorResponses } from '../../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../../common/swagger/api-paginated-response.decorator.js';
import { UserAuditCtx } from '../../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { RequireOrgPermission } from '../../organizations/guards/require-org-permission.decorator.js';
import { CreateInviteDto } from '../dto/create-invite.dto.js';
import { CreatedInviteResponseDto, InviteResponseDto } from '../dto/invite-response.dto.js';
import { InvitesService } from '../services/invites.service.js';
import type { Page } from '../../../common/pagination/pagination.types.js';

@ApiTags('Organizations')
@Controller('orgs/:orgId/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /**
   * Tạo link mời (Admin trở lên; link vai trò `admin` chỉ Owner tạo được).
   *
   * @remarks `token` CHỈ trả về một lần trong response này — hãy lưu lại link ngay.
   */
  @Post()
  @RequireOrgPermission('org.invite.manage')
  @Throttle(RateLimit.inviteCreate)
  @ApiErrorResponses(400, 429)
  create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateInviteDto,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<CreatedInviteResponseDto> {
    return this.invites.create(orgId, dto, audit);
  }

  /** Danh sách link mời, mới nhất trước. Không chứa token. */
  @Get()
  @RequireOrgPermission('org.invite.manage')
  @ApiPaginatedResponse(InviteResponseDto)
  @ApiErrorResponses(400)
  list(
    @Param('orgId') orgId: string,
    @Query() query: CursorQueryDto,
  ): Promise<Page<InviteResponseDto>> {
    return this.invites.list(orgId, query);
  }

  /** Thu hồi link mời (idempotent). */
  @Delete(':inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireOrgPermission('org.invite.manage')
  @ApiNoContentResponse({ description: 'Đã thu hồi.' })
  @ApiErrorResponses(400)
  async revoke(
    @Param('orgId') orgId: string,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<void> {
    await this.invites.revoke(orgId, inviteId, audit);
  }
}
