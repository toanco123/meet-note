import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Errors } from '../../common/errors/errors.js';
import { IfMatchVersion } from '../../common/http/if-match.js';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { RateLimit } from '../../infra/rate-limit/rate-limits.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { CurrentOrgMembership } from '../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { ActionItemResponseDto } from './dto/action-item-response.dto.js';
import { CreateActionItemDto } from './dto/create-action-item.dto.js';
import { UpdateActionItemDto } from './dto/update-action-item.dto.js';
import { ListActionItemsQueryDto } from './dto/list-action-items-query.dto.js';
import { ActionItemManagementService } from './services/action-item-management.service.js';
import { ActionItemsService } from './services/action-items.service.js';

@ApiTags('Action items')
@Controller('orgs/:orgId')
export class ActionItemsController {
  constructor(
    private readonly actionItems: ActionItemsService,
    private readonly management: ActionItemManagementService,
  ) {}

  /**
   * Việc cần làm của một cuộc họp.
   *
   * @remarks Người xem được cuộc họp (không xem được → 404). Theo thứ tự tạo; cuộc họp chưa xử lý xong
   * thì chưa có việc nào (trang rỗng). Mọi trạng thái, kể cả `done` và `dismissed`.
   */
  @Get('meetings/:meetingId/action-items')
  @RequireOrgPermission('org.meeting.read')
  @ApiPaginatedResponse(ActionItemResponseDto)
  @ApiErrorResponses(400)
  async listForMeeting(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Query() query: CursorQueryDto,
  ): Promise<Page<ActionItemResponseDto>> {
    return this.actionItems.listForMeeting(membership, user.id, meetingId, query);
  }

  /**
   * Việc cần làm xuyên các cuộc họp ("việc của tôi").
   *
   * @remarks Chỉ việc của cuộc họp bạn xem được. `assignee=me` lọc việc giao cho bạn; mặc định chỉ việc
   * `open`; `overdue=true` chỉ việc đã quá hạn theo ngày hôm nay giờ Việt Nam. Sắp xếp theo hạn (gần
   * hạn trước, việc không hạn cuối).
   */
  @Get('action-items')
  @RequireOrgPermission('org.meeting.read')
  @ApiPaginatedResponse(ActionItemResponseDto)
  @ApiErrorResponses(400, 403)
  async list(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Query() query: ListActionItemsQueryDto,
  ): Promise<Page<ActionItemResponseDto>> {
    return this.actionItems.listVisible(membership, user.id, query);
  }

  /**
   * Tạo một việc thủ công cho cuộc họp.
   *
   * @remarks Chủ cuộc họp (cuộc họp không còn chủ: Owner / Admin tổ chức). Người được giao (nếu có)
   * phải là thành viên tổ chức và xem được cuộc họp, không thì 422. Trả việc mới kèm `ETag`
   * (`"1"`). Giới hạn 120 lần / phút.
   */
  @Post('meetings/:meetingId/action-items')
  @RequireOrgPermission('org.meeting.read')
  @Throttle(RateLimit.actionItemWrite)
  @ApiErrorResponses(400, 403, 404, 422)
  async create(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Body() dto: CreateActionItemDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActionItemResponseDto> {
    const item = await this.management.create(membership, ctx, meetingId, dto);
    res.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  /**
   * Sửa một việc: nội dung, người được giao, hạn, trạng thái.
   *
   * @remarks Bắt buộc header `If-Match` mang `version` bạn đã đọc (hoặc `ETag` của lần sửa trước). Có
   * người sửa trước bạn → 412, tải lại rồi sửa tiếp; thiếu header → 428. Cần ít nhất một field.
   * Quyền: chủ cuộc họp (cuộc họp không còn chủ: Owner / Admin tổ chức) sửa mọi thứ, kể cả bỏ việc
   * (`status: dismissed`) và khôi phục; người được giao chỉ đổi `open` ↔ `done` (thử sửa thứ khác →
   * 403). Đặt `done` ghi người và lúc hoàn thành; rời `done` thì xoá. Việc đã bỏ không bị xoá khỏi
   * DB, chỉ ẩn khỏi danh sách mặc định. Giới hạn 120 lần / phút.
   */
  @Patch('action-items/:itemId')
  @RequireOrgPermission('org.meeting.read')
  @Throttle(RateLimit.actionItemWrite)
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Version hiện tại của việc, dạng `"3"` (giá trị `ETag` / `version`).',
  })
  @ApiErrorResponses(400, 403, 404, 412, 422, 428)
  async update(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @IfMatchVersion(Errors.actionItem.ifMatchRequired) expectedVersion: number,
    @Body() dto: UpdateActionItemDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActionItemResponseDto> {
    const item = await this.management.update(membership, ctx, itemId, expectedVersion, dto);
    res.setHeader('ETag', `"${item.version}"`);
    return item;
  }
}
