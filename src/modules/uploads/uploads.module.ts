import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsRepository } from './uploads.repository.js';
import { UploadsService } from './uploads.service.js';

/** Upload chunked → S3 multipart (M5). `OBJECT_STORAGE` đến từ `StorageModule` (global). */
@Module({
  imports: [OrganizationsModule, MeetingsModule],
  controllers: [UploadsController],
  providers: [UploadsRepository, UploadsService],
})
export class UploadsModule {}
