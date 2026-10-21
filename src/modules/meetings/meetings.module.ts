import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueName } from '../../infra/queue/queue.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingsService } from './meetings.service.js';

/**
 * Cuộc họp. M5: tạo meeting `queued` khi upload complete + enqueue `meeting.preprocess`.
 * M6 tách phần không-HTTP (repository, service, queue) ra `MeetingsCoreModule` cho worker dùng.
 */
@Module({
  imports: [
    OrganizationsModule,
    ChannelsModule,
    BullModule.registerQueue({ name: QueueName.Default }),
  ],
  controllers: [MeetingsController],
  providers: [MeetingsRepository, MeetingsService],
  exports: [MeetingsRepository, MeetingsService],
})
export class MeetingsModule {}
