import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../infra/database/database.types.js';
import { auditLogs } from '../../infra/database/schema/index.js';
import type { AuditContext, AuditEntry } from './audit.types.js';

@Injectable()
export class AuditService {
  /**
   * BẮT BUỘC truyền `tx` của thao tác đang làm (không có default `this.db`): ghi log ngoài transaction
   * thì thao tác rollback mà log vẫn còn ("log ma"), hoặc log lỗi mà thao tác vẫn commit
   * (thao tác quản trị không được ghi lại). Cùng transaction → cùng sống, cùng chết.
   */
  async record(tx: DbExecutor, ctx: AuditContext, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLogs).values({
      orgId: entry.orgId,
      actorId: ctx.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata ?? {},
      requestId: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
    });
  }
}
