import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ChannelsRepository } from './repositories/channels.repository.js';
import { ChannelsPurgeService } from './services/channels-purge.service.js';

/**
 * Phần không-HTTP của kênh, dùng chung api + worker (M6 B8): repository + purge kênh đã xoá. Worker
 * import module này để chạy purge theo lịch mà không kéo controller / guard / tổ chức theo.
 * `AuditModule` là global ở api; import tường minh để worker (không có `AppModule`) cũng có.
 */
@Module({
  imports: [AuditModule],
  providers: [ChannelsRepository, ChannelsPurgeService],
  exports: [ChannelsRepository, ChannelsPurgeService],
})
export class ChannelsCoreModule {}
