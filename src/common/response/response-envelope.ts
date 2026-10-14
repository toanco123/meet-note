import { SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

/**
 * Hai đánh dấu dùng CHUNG cho runtime (interceptor đọc metadata) và tài liệu (Swagger đọc extension):
 * một nguồn quyết định → response thật và `openapi.json` không thể lệch nhau.
 */
export const RAW_RESPONSE_KEY = 'meetnote:rawResponse';
export const PAGINATED_KEY = 'meetnote:paginated';
export const RAW_RESPONSE_EXTENSION = 'x-raw-response';
export const PAGINATED_EXTENSION = 'x-paginated';

/**
 * Bỏ envelope `{ data, meta }` cho controller / route này — trả thẳng body.
 * Chỉ dùng cho thứ có quy ước riêng bên ngoài, vd health check cho Docker / K8s probe.
 */
export function RawResponse(): ClassDecorator & MethodDecorator {
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      SetMetadata(RAW_RESPONSE_KEY, true)(target, key as string, descriptor);
      ApiExtension(RAW_RESPONSE_EXTENSION, true)(target, key, descriptor);
    } else {
      SetMetadata(RAW_RESPONSE_KEY, true)(target as Function);
      ApiExtension(RAW_RESPONSE_EXTENSION, true)(target);
    }
  };
}
