import { Module } from '@nestjs/common';
import { IdempotencyRepository } from './idempotency.repository.js';

/**
 * `@Idempotent()` — header `Idempotency-Key` (M5). Không `@Global()`: module nào có route dùng
 * decorator thì import tường minh, nhìn `imports` là biết module đó phụ thuộc vào đâu. Quên import
 * thì Nest báo lỗi DI ngay lúc khởi động, không âm thầm sai.
 */
@Module({
  providers: [IdempotencyRepository],
  exports: [IdempotencyRepository],
})
export class IdempotencyModule {}
