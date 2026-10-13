import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { AuthService } from './auth.service.js';
import { AuthTokensResponseDto } from './dto/auth-tokens-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { sessionMetaOf } from './session-meta.js';
import { SessionsService } from './sessions.service.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Đăng ký tài khoản mới và đăng nhập luôn.
   *
   * @remarks Email trùng (không phân biệt hoa thường) trả 409 `AUTH_EMAIL_TAKEN`.
   */
  @Public()
  @Post('register')
  @ApiErrorResponses(400, 409)
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<AuthTokensResponseDto> {
    return AuthTokensResponseDto.from(await this.auth.register(dto, sessionMetaOf(req)));
  }

  /**
   * Đăng nhập bằng email + mật khẩu.
   *
   * @remarks Sai email hoặc sai mật khẩu đều trả CÙNG 401 `AUTH_INVALID_CREDENTIALS`.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiErrorResponses(400, 401)
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthTokensResponseDto> {
    return AuthTokensResponseDto.from(await this.auth.login(dto, sessionMetaOf(req)));
  }

  /**
   * Đổi refresh token lấy cặp token mới (xoay vòng).
   *
   * @remarks Mỗi refresh token chỉ dùng được một lần. Dùng lại token cũ trong 10 giây (hai tab
   * refresh cùng lúc) → 401 `AUTH_REFRESH_TOKEN_ROTATED`; quá 10 giây → coi là bị đánh cắp,
   * thu hồi cả phiên và trả 401 `AUTH_REFRESH_TOKEN_REUSED`.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiErrorResponses(400, 401)
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensResponseDto> {
    return AuthTokensResponseDto.from(await this.sessions.rotate(dto.refreshToken));
  }

  /**
   * Đăng xuất phiên hiện tại.
   *
   * @remarks Access token của phiên này bị từ chối ngay ở request tiếp theo; refresh token hết dùng được.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Đã thu hồi phiên.' })
  @ApiErrorResponses(401)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.sessions.revoke(user.sessionId, user.id, 'logout');
  }

  /** Đăng xuất khỏi MỌI thiết bị (thu hồi mọi phiên của tài khoản, kể cả phiên hiện tại). */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Đã thu hồi mọi phiên.' })
  @ApiErrorResponses(401)
  async logoutAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.sessions.revokeAll(user.id);
  }
}
