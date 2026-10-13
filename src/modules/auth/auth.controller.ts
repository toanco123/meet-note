import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { AuthService } from './auth.service.js';
import { AuthTokensResponseDto } from './dto/auth-tokens-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { sessionMetaOf } from './session-meta.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
}
