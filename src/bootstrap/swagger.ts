import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { applyResponseEnvelope } from '../common/response/openapi-envelope.js';
import { PaginatedMetaDto, ResponseMetaDto } from '../common/response/response-meta.dto.js';

export const SWAGGER_PATH = 'docs';
export const SWAGGER_JSON_PATH = 'docs-json';

/** Thứ tự tag = thứ tự hiển thị trong Swagger UI. */
const TAGS: ReadonlyArray<[name: string, description: string]> = [
  ['Health', 'Kiểm tra tình trạng tiến trình'],
  ['Auth', 'Đăng ký, đăng nhập, phiên đăng nhập'],
  ['Organizations', 'Tổ chức, thành viên, lời mời, audit log'],
  ['Channels', 'Kênh và thành viên kênh'],
  ['Meetings', 'Upload, cuộc họp, transcript, tóm tắt, tìm kiếm'],
  ['Action items', 'Việc cần làm của cuộc họp, "việc của tôi"'],
  ['Dashboard', 'Số liệu tổng hợp của tổ chức (Owner / Admin)'],
  ['Reports', 'Báo cáo tuần của kênh'],
  ['Notifications', 'Thông báo trong ứng dụng'],
];

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('MeetNote API')
    .setDescription(
      [
        'API biên bản họp theo nhóm.',
        '',
        '- Thành công: `{ data, meta: { statusCode, requestId } }`. Danh sách: `data` là mảng, `meta.nextCursor` để lấy trang sau (query `cursor` + `limit`).',
        '- Lỗi luôn có dạng `{ error: { code, statusCode, message, details?, requestId } }`.',
        '- `204` không có body. `/health/*` trả thẳng body (không bọc).',
        '- Mọi response có header `x-request-id` (trùng `meta.requestId` / `error.requestId`).',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Access token lấy từ `POST /v1/auth/login`.',
    })
    // Mặc định MỌI route yêu cầu Bearer (khớp với JwtAuthGuard toàn cục). Route @Public()
    // ghi đè bằng `security: [{}]` ở cấp operation.
    .addSecurityRequirements('bearer');

  for (const [name, description] of TAGS) {
    builder.addTag(name, description);
  }

  const document = SwaggerModule.createDocument(app, builder.build(), {
    // operationId ổn định → tên hàm trong client sinh ra ổn định: `Health_live`, `Channels_create`…
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
    extraModels: [ResponseMetaDto, PaginatedMetaDto],
  });
  return applyResponseEnvelope(document);
}

export function setupSwagger(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    customSiteTitle: 'MeetNote API',
    swaggerOptions: {
      // Giữ token đã nhập ở nút Authorize khi reload trang (lưu localStorage).
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'none',
      filter: true,
    },
  });
}
