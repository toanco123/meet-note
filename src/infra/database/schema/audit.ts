import { sql } from 'drizzle-orm';
import { bigint, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Nhật ký thao tác quản trị — CHỈ GHI THÊM (trigger `audit_logs_append_only` chặn UPDATE/DELETE,
 * xem migration viết tay). Cố ý KHÔNG có FK tới organizations/users: log phải sống lâu hơn bản
 * ghi nó mô tả, và FK `SET NULL` sẽ phải UPDATE dòng log — điều trigger cấm.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    // bigint identity: bảng ghi nhiều, cần khoá tăng dần rẻ; không lộ ra ngoài như uuid.
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid().notNull(),
    /** NULL = hệ thống (job, migration…). */
    actorId: uuid(),
    /** `domain.object.verb_past`, vd `org.member.role_changed`. */
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text().notNull(),
    /** Thường là `{ before, after }`. */
    metadata: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    requestId: text(),
    ip: inet(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(
      t.orgId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;
