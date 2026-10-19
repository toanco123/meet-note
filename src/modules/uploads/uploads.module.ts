import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsRepository } from './uploads.repository.js';
import { UploadsService } from './uploads.service.js';

/** Upload chunked → S3 multipart (M5). `OBJECT_STORAGE` đến từ `StorageModule` (global). */
@Module({
  imports: [OrganizationsModule],
  controllers: [UploadsController],
  providers: [UploadsRepository, UploadsService],
})
export class UploadsModule {}
