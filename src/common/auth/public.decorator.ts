import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';

export const IS_PUBLIC_KEY = 'meetnote:isPublic';

/**
 * Bỏ qua `JwtAuthGuard` (guard toàn cục) cho route hoặc cả controller.
 *
 * `ApiSecurity({})` → OpenAPI `security: [{}]` = "không cần xác thực", ghi đè yêu cầu Bearer mặc
 * định ở cấp tài liệu (xem bootstrap/swagger.ts). Nhờ vậy Swagger UI không hiện ổ khoá ở route public.
 */
export const Public = () => applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), ApiSecurity({}));
