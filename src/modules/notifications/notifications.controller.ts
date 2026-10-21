import {
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
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import {
  ListNotificationsQueryDto,
  NotificationOrgFilterDto,
  UnreadCountResponseDto,
} from './dto/notification-query.dto.js';
import { NotificationResponseDto } from './dto/notification-response.dto.js';
import { NotificationsService } from './services/notifications.service.js';

/** Thông báo của CHÍNH người gọi (không nằm dưới `/orgs/:orgId`: một người, nhiều tổ chức). */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Thông báo của bạn, mới nhất trước.
   *
   * @remarks Lọc `orgId`, `unreadOnly`. Thông báo của tổ chức bạn đã rời không còn ở đây.
   */
  @Get()
  @ApiPaginatedResponse(NotificationResponseDto)
  @ApiErrorResponses(400)
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<Page<NotificationResponseDto>> {
    return this.notifications.list(user.id, query);
  }

  /** Số thông báo chưa đọc (tối đa 100, hiển thị `"99+"`). */
  @Get('unread-count')
  @ApiErrorResponses(400)
  async unreadCount(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationOrgFilterDto,
  ): Promise<UnreadCountResponseDto> {
    return this.notifications.unreadCount(user.id, query.orgId);
  }

  /** Đánh dấu tất cả đã đọc (trong một tổ chức nếu có `orgId`). */
  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiErrorResponses(400)
  async markAllRead(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationOrgFilterDto,
  ): Promise<void> {
    await this.notifications.markAllRead(user.id, query.orgId);
  }

  /** Đánh dấu đã đọc. Gọi lại → 204. Của người khác → 404. */
  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiErrorResponses(400, 404)
  async markRead(
    @CurrentUser() user: AuthUser,
    @Param('notificationId', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }

  /** Xoá (mềm). Gọi lại → 204. Của người khác → 404. */
  @Delete(':notificationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiErrorResponses(400, 404)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('notificationId', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.notifications.remove(user.id, id);
  }
}
