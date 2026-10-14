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
} from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { MeResponseDto } from './dto/me-response.dto.js';
import { SessionResponseDto } from './dto/session-response.dto.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { MeService } from './me.service.js';

/** Tài nguyên của chính người đang đăng nhập. Không có `:userId` trên path → không thể nhắm người khác. */
@ApiTags('Auth')
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  /** Hồ sơ của tôi. */
  @Get()
  @ApiErrorResponses(401)
  async get(@CurrentUser() user: AuthUser): Promise<MeResponseDto> {
    return this.me.profile(user);
  }

  /** Đổi tên hiển thị. */
  @Patch()
  @ApiErrorResponses(400, 401)
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto): Promise<MeResponseDto> {
    return this.me.rename(user, dto.displayName);
  }

  /**
   * Các phiên đăng nhập còn hiệu lực (thiết bị).
   *
   * @remarks Phiên đang gửi request có `current: true`. Ít phần tử nên không phân trang.
   */
  @Get('sessions')
  @ApiErrorResponses(401)
  listSessions(@CurrentUser() user: AuthUser): Promise<SessionResponseDto[]> {
    return this.me.listSessions(user);
  }

  /**
   * Thu hồi một phiên (đăng xuất một thiết bị).
   *
   * @remarks Phiên không tồn tại, của người khác hoặc đã thu hồi → 404.
   */
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Đã thu hồi phiên.' })
  @ApiErrorResponses(400, 401, 404)
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<void> {
    await this.me.revokeSession(user, sessionId);
  }
}
