import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { MeetingResponseDto } from '../meetings/dto/meeting-response.dto.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import { InitUploadDto } from './dto/init-upload.dto.js';
import { UploadPartResponseDto, UploadResponseDto } from './dto/upload-response.dto.js';
import { UploadsService } from './services/uploads.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * Bắt đầu upload một file ghi âm (tối đa 2 GiB).
   *
   * @remarks Trả `chunkSize` (8 MiB) và `totalParts`. Gửi từng phần bằng
   * `PUT …/uploads/:uploadId/parts/:partNumber` (có thể song song), rồi `POST …/complete`.
   * Upload hết hạn sau 24 giờ nếu chưa complete. Gửi kèm `Idempotency-Key` để gọi lại an toàn khi
   * mất kết nối (gọi lại không kèm key sẽ mở thêm một upload mới).
   */
  @Post()
  @RequireOrgPermission('org.upload')
  @Idempotent()
  @ApiErrorResponses(400)
  async init(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: InitUploadDto,
  ): Promise<UploadResponseDto> {
    return UploadResponseDto.from(await this.uploads.init(orgId, user.id, dto));
  }

  /**
   * Trạng thái upload + các phần đã nhận (dùng để resume).
   *
   * @remarks Chỉ người tạo xem được; người khác nhận 404.
   */
  @Get(':uploadId')
  @RequireOrgPermission('org.upload')
  @ApiErrorResponses(400)
  async get(
    @Param('orgId') orgId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<UploadResponseDto> {
    return UploadResponseDto.from(await this.uploads.get(orgId, user.id, uploadId));
  }

  /**
   * Gửi một phần của file.
   *
   * @remarks Body `application/octet-stream`, `Content-Length` đúng bằng `chunkSize` (phần cuối:
   * phần còn lại). Gửi lại cùng phần → ghi đè (idempotent). Gửi song song nhiều phần được.
   * Server stream thẳng sang S3, không giữ cả phần trong bộ nhớ.
   */
  @Put(':uploadId/parts/:partNumber')
  @RequireOrgPermission('org.upload')
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiErrorResponses(400, 409, 410, 411, 413, 415)
  async uploadPart(
    @Param('orgId') orgId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @Param('partNumber', new ParseIntPipe()) partNumber: number,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadPartResponseDto> {
    // Response đóng mà chưa gửi xong = client đã đi. SDK đẩy body lên S3 bằng `pipe()`, mà `pipe()`
    // KHÔNG truyền lỗi của nguồn sang đích → request S3 sẽ treo chờ byte không bao giờ tới. Huỷ chủ động.
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      return await this.uploads.uploadPart(orgId, user.id, uploadId, partNumber, {
        body: req,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        signal: abort.signal,
      });
    } catch (error) {
      // Từ chối khi body CHƯA đọc hết (vd 413 trước khi đọc): đóng kết nối sau response. Không thì
      // Node đọc-rồi-bỏ phần body còn lại để giữ keep-alive (`req._dump()`) — tốn băng thông vô ích.
      if (!req.complete) res.setHeader('Connection', 'close');
      throw error;
    }
  }

  /**
   * Hoàn tất upload → tạo cuộc họp (trạng thái `queued`, chờ xử lý).
   *
   * @remarks Còn thiếu phần → 409 `UPLOAD_INCOMPLETE` (`details` liệt kê phần thiếu). Gọi lại khi
   * đã hoàn tất → 200 với đúng cuộc họp đã tạo (không tạo thêm).
   */
  @Post(':uploadId/complete')
  @RequireOrgPermission('org.upload')
  @ApiOkResponse({
    type: MeetingResponseDto,
    description: 'Đã hoàn tất từ trước: trả lại cuộc họp đó.',
  })
  @ApiErrorResponses(400, 409, 410)
  async complete(
    @Param('orgId') orgId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @UserAuditCtx() ctx: UserAuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeetingResponseDto> {
    const { meeting, created } = await this.uploads.complete(
      orgId,
      ctx.actorId,
      uploadId,
      ctx.requestId ?? null,
    );
    // 201 lần đầu, 200 khi gọi lại. Envelope đọc `res.statusCode` nên `meta.statusCode` khớp theo.
    if (!created) res.status(HttpStatus.OK);
    return MeetingResponseDto.from(meeting);
  }

  /**
   * Huỷ upload.
   *
   * @remarks Gọi lại khi đã huỷ / đã hết hạn → vẫn 204. Upload đã complete → 409 `UPLOAD_NOT_ACTIVE`.
   */
  @Delete(':uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireOrgPermission('org.upload')
  @ApiNoContentResponse({ description: 'Đã huỷ upload.' })
  @ApiErrorResponses(400, 409)
  async cancel(
    @Param('orgId') orgId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.uploads.cancel(orgId, user.id, uploadId);
  }
}
