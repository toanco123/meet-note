import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { PaginatedResponseDto } from '../pagination/paginated-response.dto.js';

/**
 * Response danh sách `{ data: Model[], nextCursor }`.
 * Cách dùng: `@ApiPaginatedResponse(MemberResponseDto)` trên method trả `Promise<Page<MemberResponseDto>>`.
 */
export function ApiPaginatedResponse(model: Type<unknown>, description?: string) {
  return applyDecorators(
    ApiExtraModels(PaginatedResponseDto, model),
    ApiOkResponse({
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedResponseDto) },
          {
            type: 'object',
            required: ['data'],
            properties: {
              data: { type: 'array', items: { $ref: getSchemaPath(model) } },
            },
          },
        ],
      },
    }),
  );
}
