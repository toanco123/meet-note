import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import {
  JoinRequestDecisionResponseDto,
  JoinRequestResponseDto,
  ListJoinRequestsQueryDto,
} from './dto/join-request.dto.js';
import { JoinRequestsService } from './join-requests.service.js';
import type { Page } from '../../common/pagination/pagination.types.js';

@ApiTags('Organizations')
@Controller('orgs/:orgId/join-requests')
export class JoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  /** Yêu cầu tham gia (mặc định đang chờ), mới nhất trước. */
  @Get()
  @RequireOrgPermission('org.join_request.manage')
  @ApiPaginatedResponse(JoinRequestResponseDto)
  @ApiErrorResponses(400)
  list(
    @Param('orgId') orgId: string,
    @Query() query: ListJoinRequestsQueryDto,
  ): Promise<Page<JoinRequestResponseDto>> {
    return this.requests.list(orgId, query);
  }

  /**
   * Duyệt yêu cầu.
   *
   * @remarks Yêu cầu vào với vai trò `admin` chỉ Owner duyệt được. Đã xử lý → 409.
   */
  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission('org.join_request.manage')
  @ApiErrorResponses(400, 409)
  approve(
    @Param('orgId') orgId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<JoinRequestDecisionResponseDto> {
    return this.requests.approve(orgId, requestId, audit);
  }

  /** Từ chối yêu cầu. Người đó có thể gửi yêu cầu mới bằng link khác. */
  @Post(':requestId/reject')
  @HttpCode(HttpStatus.OK)
  @RequireOrgPermission('org.join_request.manage')
  @ApiErrorResponses(400, 409)
  reject(
    @Param('orgId') orgId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<JoinRequestDecisionResponseDto> {
    return this.requests.reject(orgId, requestId, audit);
  }
}
