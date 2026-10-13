import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'docs';
export const SWAGGER_JSON_PATH = 'docs-json';

/** Thứ tự tag = thứ tự hiển thị trong Swagger UI. */
const TAGS: ReadonlyArray<[name: string, description: string]> = [
  ['Health', 'Kiểm tra tình trạng tiến trình'],
  ['Auth', 'Đăng ký, đăng nhập, phiên đăng nhập'],
  ['Organizations', 'Tổ chức, thành viên, lời mời, audit log'],
  ['Channels', 'Kênh và thành viên kênh'],
  ['Meetings', 'Upload, cuộc họp, transcript, tóm tắt, tìm kiếm'],
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
        '- Lỗi luôn có dạng `{ error: { code, message, details?, requestId } }`.',
        '- Danh sách phân trang cursor: `{ data, nextCursor }`, query `cursor` + `limit`.',
        '- Mọi response có header `x-request-id`.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Access token lấy từ `POST /v1/auth/login`.',
    });

  for (const [name, description] of TAGS) {
    builder.addTag(name, description);
  }

  return SwaggerModule.createDocument(app, builder.build(), {
    // operationId ổn định → tên hàm trong client sinh ra ổn định: `Health_live`, `Channels_create`…
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
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
