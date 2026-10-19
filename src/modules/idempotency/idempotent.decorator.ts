import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * Cho route nhận header `Idempotency-Key`: gọi lại cùng key + cùng nội dung → trả lại đúng response
 * lần đầu, không chạy lại thao tác.
 *
 * - Module chứa controller phải import `IdempotencyModule` (interceptor được tạo trong module của
 *   controller nên cần thấy `IdempotencyRepository`).
 * - Chỉ cho route trả MỘT DTO (không phải danh sách).
 * - KHÔNG gắn cho route trả bí mật (token, mật khẩu tạm): response được lưu nguyên văn trong DB.
 * - Route tự idempotent theo trạng thái (vd complete upload) không cần decorator này.
 */
export function Idempotent() {
  return applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'Tuỳ chọn, 1–255 ký tự ASCII in được, theo từng người dùng, giữ 24 giờ. Gửi lại cùng key + cùng nội dung → nhận lại đúng response lần đầu (header `Idempotent-Replayed: true`). Request đầu chưa xong → 409 `IDEMPOTENCY_IN_PROGRESS`; nội dung khác → 422 `IDEMPOTENCY_KEY_REUSED`. Request lỗi không được ghi nhớ.',
      schema: { type: 'string', minLength: 1, maxLength: 255 },
    }),
    ApiErrorResponses(409, 422),
  );
}
