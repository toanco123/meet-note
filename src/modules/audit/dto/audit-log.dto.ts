import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import type { AuditLogListRow } from '../audit.types.js';
import { AUDIT_ACTIONS, type AuditAction } from '../audit-actions.js';

export class ListAuditLogsQueryDto extends CursorQueryDto {
  /** Lọc theo loại hành động. */
  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  @ApiProperty({ enum: AUDIT_ACTIONS, enumName: 'AuditAction', required: false })
  action?: AuditAction;

  /** Lọc theo người thực hiện. */
  @IsOptional()
  @IsUUID()
  actorId?: string;
}

export class AuditLogResponseDto {
  /** @example 1024 */
  id: number;

  @ApiProperty({ enum: AUDIT_ACTIONS, enumName: 'AuditAction' })
  action: string;

  /** `null` = hệ thống. */
  @ApiProperty({ type: String, nullable: true })
  actorId: string | null;

  /** `null` nếu người thực hiện đã bị xoá (log không có FK, vẫn giữ nguyên). */
  @ApiProperty({ type: String, nullable: true })
  actorDisplayName: string | null;

  /** @example "member" */
  targetType: string;

  targetId: string;

  /** Thường là `{ before, after }`. */
  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;

  @ApiProperty({ type: String, nullable: true })
  ip: string | null;

  createdAt: string;

  static from(row: AuditLogListRow): AuditLogResponseDto {
    return {
      id: row.id,
      action: row.action,
      actorId: row.actorId,
      actorDisplayName: row.actorDisplayName,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata,
      requestId: row.requestId,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
