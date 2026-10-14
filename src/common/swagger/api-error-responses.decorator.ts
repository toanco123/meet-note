import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from '../errors/error-response.dto.js';

export type DocumentedErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429;

const DESCRIPTIONS: Record<DocumentedErrorStatus, string> = {
  400: 'Dữ liệu không hợp lệ (`VALIDATION_FAILED`, `INVALID_CURSOR`).',
  401: 'Thiếu hoặc sai access token (`UNAUTHENTICATED`).',
  403: 'Không đủ quyền với hành động này (`FORBIDDEN`).',
  404: 'Không tồn tại hoặc bạn không được phép thấy (`NOT_FOUND`).',
  409: 'Xung đột trạng thái hoặc dữ liệu trùng (`CONFLICT` hoặc mã cụ thể).',
  410: 'Từng hợp lệ nhưng không còn dùng được, vd link mời hết hạn / hết lượt (`INVITE_EXPIRED`, `INVITE_EXHAUSTED`).',
  413: 'Payload quá lớn (`PAYLOAD_TOO_LARGE`).',
  429: 'Gửi quá nhiều request (`RATE_LIMITED`).',
};

/**
 * Khai báo các response lỗi (cùng schema `ErrorResponseDto`) cho một route/controller.
 * Cách dùng: `@ApiErrorResponses(400, 401, 403, 404, 409)`.
 */
export function ApiErrorResponses(...statuses: DocumentedErrorStatus[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: DESCRIPTIONS[status], type: ErrorResponseDto }),
    ),
  );
}
