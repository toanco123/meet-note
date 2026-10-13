import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Global: mọi module có thao tác quản trị đều cần ghi audit, không phải import từng nơi. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
