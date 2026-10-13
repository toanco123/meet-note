import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { auditLogs, users } from '../../infra/database/schema/index.js';
import type { AuditAction } from './audit.types.js';

export interface AuditLogListRow {
  id: number;
  action: string;
  actorId: string | null;
  actorDisplayName: string | null;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
  ip: string | null;
  createdAt: Date;
  createdAtKey: string;
}

@Injectable()
export class AuditLogsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Mới nhất trước, khớp index `audit_logs_org_created_idx (org_id, created_at DESC, id DESC)`.
   * LEFT JOIN users: audit không có FK → actor có thể đã bị xoá → tên hiển thị NULL, log vẫn còn.
   */
  list(params: {
    orgId: string;
    action?: AuditAction;
    actorId?: string;
    after?: [string, number];
    limit: number;
  }): Promise<AuditLogListRow[]> {
    const { orgId, action, actorId, after, limit } = params;
    return this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorId: auditLogs.actorId,
        actorDisplayName: users.displayName,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        metadata: auditLogs.metadata,
        requestId: auditLogs.requestId,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
        createdAtKey: timestampKey(auditLogs.createdAt),
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(
        and(
          eq(auditLogs.orgId, orgId),
          action ? eq(auditLogs.action, action) : undefined,
          actorId ? eq(auditLogs.actorId, actorId) : undefined,
          after
            ? sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${after[0]}::timestamptz, ${after[1]}::bigint)`
            : undefined,
        ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);
  }
}
