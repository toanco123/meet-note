import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { ActionItemsController } from './action-items.controller.js';
import { ActionItemsCoreModule } from './action-items-core.module.js';
import { ActionItemManagementService } from './services/action-item-management.service.js';
import { ActionItemsService } from './services/action-items.service.js';

/** API việc cần làm (M12). Quyền xem lấy từ `meetingVisibleTo` của module meetings. */
@Module({
  imports: [OrganizationsModule, MeetingsModule, ActionItemsCoreModule],
  controllers: [ActionItemsController],
  providers: [ActionItemsService, ActionItemManagementService],
})
export class ActionItemsModule {}
