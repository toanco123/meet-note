import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { CurrentOrgMembership } from '../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { ActionItemResponseDto } from './dto/action-item-response.dto.js';
import { ListActionItemsQueryDto } from './dto/list-action-items-query.dto.js';
import { ActionItemsService } from './services/action-items.service.js';

@ApiTags('Action items')
@Controller('orgs/:orgId')
export class ActionItemsController {
  constructor(private readonly actionItems: ActionItemsService) {}

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
}
