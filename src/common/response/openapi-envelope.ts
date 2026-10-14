import type { OpenAPIObject } from '@nestjs/swagger';
import { getSchemaPath } from '@nestjs/swagger';
import { PAGINATED_EXTENSION, RAW_RESPONSE_EXTENSION } from './response-envelope.js';
import { PaginatedMetaDto, ResponseMetaDto } from './response-meta.dto.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;

/**
 * Bản "tài liệu" của `ResponseEnvelopeInterceptor`: bọc schema của mọi response 2xx JSON thành
 * `{ data: <schema cũ>, meta }`. Làm MỘT lần trên cả document thay vì decorator ở từng route →
 * không route nào quên. Dựa trên đúng hai đánh dấu interceptor dùng (`x-raw-response`, `x-paginated`).
 * Model `ResponseMetaDto` / `PaginatedMetaDto` phải có trong `extraModels` khi tạo document.
 */
export function applyResponseEnvelope(document: OpenAPIObject): OpenAPIObject {
  for (const pathItem of Object.values(document.paths)) {
    for (const method of METHODS) {
      const operation = pathItem[method] as
        (NonNullable<(typeof pathItem)['get']> & Record<string, unknown>) | undefined;
      if (!operation || operation[RAW_RESPONSE_EXTENSION] === true) continue;

      const meta = operation[PAGINATED_EXTENSION] === true ? PaginatedMetaDto : ResponseMetaDto;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (!status.startsWith('2') || !response || !('content' in response)) continue;
        const json = response.content?.['application/json'];
        if (!json?.schema) continue;
        json.schema = {
          type: 'object',
          required: ['data', 'meta'],
          properties: { data: json.schema, meta: { $ref: getSchemaPath(meta) } },
        };
      }
    }
  }
  return document;
}
