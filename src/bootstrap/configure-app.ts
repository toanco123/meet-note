import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import type { Express } from 'express';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { OrgContext } from '../infra/database/org-context.js';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter.js';
import { validationExceptionFactory } from '../common/errors/validation-exception.factory.js';
import { ResponseEnvelopeInterceptor } from '../common/response/response-envelope.interceptor.js';
import { RedisIoAdapter } from '../infra/realtime/redis-io.adapter.js';

/**
 * Cấu hình HTTP app dùng chung cho `main.ts` và e2e test — test chạy đúng cấu hình production.
 *
 * Thứ tự quan trọng: versioning phải bật TRƯỚC khi tạo tài liệu Swagger,
 * nếu không đường dẫn trong OpenAPI sẽ thiếu tiền tố `/v1`.
 */
export function configureApp(app: INestApplication): void {
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Ngữ cảnh tổ chức RỖNG cho mỗi request HTTP (M11 B7) — `OrgMemberGuard` điền sau khi xác nhận
  // thành viên. Đăng ký TRƯỚC mọi middleware / route để cả request đi trong cùng ngữ cảnh async.
  app.use((_req: unknown, _res: unknown, next: () => void) => OrgContext.run(next));

  // `req.ip` (rate limit, phiên đăng nhập) lấy từ `X-Forwarded-For` CHỈ khi có proxy tin cậy đứng
  // trước — 0 tầng thì header do client gửi bị bỏ qua (M11 B3).
  const proxyHops = app.get(ConfigService<EnvironmentVariables, true>).get('TRUST_PROXY_HOPS', {
    infer: true,
  });
  if (proxyHops > 0) (app.getHttpAdapter().getInstance() as Express).set('trust proxy', proxyHops);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // BẪY: implicit conversion biến "false" thành true. Ép kiểu tường minh bằng @Type/@Transform.
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: validationExceptionFactory,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  // Thành công → `{ data, meta }`; lỗi → `{ error }` (filter ở trên). Xem 07-conventions §3.
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
  // Socket.IO qua Redis adapter: đúng với nhiều api instance + nhận event worker phát (M7).
  app.useWebSocketAdapter(new RedisIoAdapter(app));
}
