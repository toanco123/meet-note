import { Module } from '@nestjs/common';
import { UploadsCleanupService } from './services/uploads-cleanup.service.js';
import { UploadsRepository } from './uploads.repository.js';

/**
 * Phần không-HTTP của upload, dùng chung api + worker (M6 B8): api huỷ upload cần
 * `abortInStorage`; worker chạy dọn upload hết hạn theo lịch. `OBJECT_STORAGE` từ `StorageModule`.
 */
@Module({
  providers: [UploadsRepository, UploadsCleanupService],
  exports: [UploadsRepository, UploadsCleanupService],
})
export class UploadsCoreModule {}
