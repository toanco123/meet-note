import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter.js';
import { validationExceptionFactory } from '../common/errors/validation-exception.factory.js';

/**
 * Cấu hình HTTP app dùng chung cho `main.ts` và e2e test — test chạy đúng cấu hình production.
 *
 * Thứ tự quan trọng: versioning phải bật TRƯỚC khi tạo tài liệu Swagger,
 * nếu không đường dẫn trong OpenAPI sẽ thiếu tiền tố `/v1`.
 */
export function configureApp(app: INestApplication): void {
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

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
}
