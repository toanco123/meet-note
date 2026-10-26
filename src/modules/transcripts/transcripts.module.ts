import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { TranscriptsController } from './transcripts.controller.js';
import { TranscriptsRepository } from './transcripts.repository.js';
import { TranscriptsService } from './transcripts.service.js';

/** Tìm kiếm và xuất transcript (M8). Quyền xem lấy từ `meetingVisibleTo` của module meetings. */
@Module({
  imports: [OrganizationsModule, MeetingsModule],
  controllers: [TranscriptsController],
  providers: [TranscriptsRepository, TranscriptsService],
})
export class TranscriptsModule {}
