import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RateLimit } from '../../../infra/rate-limit/rate-limits.js';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator.js';
import { ApiErrorResponses } from '../../../common/swagger/api-error-responses.decorator.js';
import { UserAuditCtx } from '../../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { AcceptInviteResponseDto, InvitePreviewResponseDto } from '../dto/invite-acceptance.dto.js';
import { InviteAcceptanceService } from '../services/invite-acceptance.service.js';

@ApiTags('Organizations')
@Controller('invites/:token')
export class InviteAcceptanceController {
  constructor(private readonly acceptance: InviteAcceptanceService) {}

  /**
   * Xem trước link mời (không cần đăng nhập).
   *
   * @remarks Không có / đã thu hồi → 404 `INVITE_NOT_FOUND`; hết hạn / hết lượt → 410.
   */
  @Public()
  @Get()
  @ApiErrorResponses(404, 410)
  preview(@Param('token') token: string): Promise<InvitePreviewResponseDto> {
    return this.acceptance.preview(token);
  }

  /**
   * Chấp nhận link mời.
   *
   * @remarks Tổ chức không cần duyệt → vào thẳng (`joined`); cần duyệt → tạo yêu cầu (`pending`).
   * Đã là thành viên → 409 `ORG_ALREADY_MEMBER` (không bị trừ lượt).
   */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Throttle(RateLimit.inviteAccept)
  @ApiErrorResponses(401, 404, 409, 410, 429)
  accept(
    @Param('token') token: string,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<AcceptInviteResponseDto> {
    return this.acceptance.accept(token, audit);
  }
}
