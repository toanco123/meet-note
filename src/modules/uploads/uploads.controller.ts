import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import { InitUploadDto } from './dto/init-upload.dto.js';
import { UploadResponseDto } from './dto/upload-response.dto.js';
import { UploadsService } from './uploads.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * Bắt đầu upload một file ghi âm (tối đa 2 GiB).
   *
   * @remarks Trả `chunkSize` (8 MiB) và `totalParts`. Gửi từng phần bằng
   * `PUT …/uploads/:uploadId/parts/:partNumber` (có thể song song), rồi `POST …/complete`.
   * Upload hết hạn sau 24 giờ nếu chưa complete.
   */
  @Post()
  @RequireOrgPermission('org.upload')
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
