import { applyDecorators, SetMetadata, type Type } from '@nestjs/common';
import { ApiExtension, ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { PAGINATED_EXTENSION, PAGINATED_KEY } from '../response/response-envelope.js';

/**
 * Route danh sách: method trả `Promise<Page<Model>>`, client nhận
 * `{ data: Model[], meta: { requestId, nextCursor } }`.
 *
 * Decorator này chỉ ĐÁNH DẤU + mô tả mảng `Model[]`. Việc bọc `{ data, meta }` do
 * `ResponseEnvelopeInterceptor` (runtime) và `applyResponseEnvelope` (Swagger) làm, cùng dựa trên
 * đánh dấu này. Cần decorator vì Swagger plugin không hiểu generic `Page<T>`.
 */
export function ApiPaginatedResponse(model: Type<unknown>, description?: string) {
  return applyDecorators(
    SetMetadata(PAGINATED_KEY, true),
    ApiExtension(PAGINATED_EXTENSION, true),
    ApiExtraModels(model),
    ApiOkResponse({
      description,
      schema: { type: 'array', items: { $ref: getSchemaPath(model) } },
    }),
  );
}
