import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsCoreModule } from './uploads-core.module.js';
import { UploadsService } from './services/uploads.service.js';

/** Upload chunked → S3 multipart (M5). `OBJECT_STORAGE` đến từ `StorageModule` (global). */
@Module({
  imports: [UploadsCoreModule, OrganizationsModule, MeetingsModule, IdempotencyModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
