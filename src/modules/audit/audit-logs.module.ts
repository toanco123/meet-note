import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AuditLogsController } from './audit-logs.controller.js';
import { AuditLogsRepository } from './audit-logs.repository.js';

/**
 * API ĐỌC audit log (HTTP). Tách khỏi `AuditModule` (chỉ ghi, global) để worker (M6) dùng được
 * `AuditService` mà không kéo theo controller và guard của tổ chức.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsRepository],
})
export class AuditLogsModule {}
