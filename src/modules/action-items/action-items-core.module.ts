import { Module } from '@nestjs/common';
import { ActionItemExtractionService } from './action-item-extraction.service.js';
import { ActionItemsRepository } from './action-items.repository.js';

/** Phần không-HTTP của action items dùng chung api + worker (M12): repository + trích việc. */
@Module({
  providers: [ActionItemsRepository, ActionItemExtractionService],
  exports: [ActionItemsRepository, ActionItemExtractionService],
})
export class ActionItemsCoreModule {}
