import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsRepository } from './uploads.repository.js';
import { UploadsCleanupService } from './services/uploads-cleanup.service.js';
import { UploadsService } from './services/uploads.service.js';

/** Upload chunked → S3 multipart (M5). `OBJECT_STORAGE` đến từ `StorageModule` (global). */
@Module({
  imports: [OrganizationsModule, MeetingsModule, IdempotencyModule],
  controllers: [UploadsController],
  providers: [UploadsRepository, UploadsService, UploadsCleanupService],
})
export class UploadsModule {}
