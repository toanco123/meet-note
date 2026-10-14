import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../../src/common/auth/auth.types.js';
import { CurrentUser } from '../../src/common/auth/current-user.decorator.js';
import { Public } from '../../src/common/auth/public.decorator.js';

/**
 * Controller chỉ có trong test: `GET /v1/__probe/private` (cần đăng nhập, trả `req.user`) và
 * `GET /v1/__probe/public` (@Public). Dùng để kiểm tra guard/token độc lập với tính năng thật.
 * Gắn vào app bằng `createTestApp({ controllers: [ProbeController] })`.
 */
@Controller('__probe')
export class ProbeController {
  @Get('private')
  whoami(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }
}
