import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueName } from '../../infra/queue/queue.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { ChannelMeetingsController } from './controllers/channel-meetings.controller.js';
import { MeetingsController } from './controllers/meetings.controller.js';
import { MeetingSharesRepository } from './repositories/meeting-shares.repository.js';
import { MeetingsRepository } from './repositories/meetings.repository.js';
import { MeetingSharesService } from './services/meeting-shares.service.js';
import { MeetingsService } from './services/meetings.service.js';

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
  controllers: [MeetingsController, ChannelMeetingsController],
  providers: [MeetingsRepository, MeetingsService, MeetingSharesRepository, MeetingSharesService],
  exports: [MeetingsRepository, MeetingsService],
})
export class MeetingsModule {}
