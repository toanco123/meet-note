import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import { expectPositiveIntKey, expectTimestampKey } from '../../common/pagination/keys.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import { AuditLogsRepository } from './audit-logs.repository.js';
import { AuditLogResponseDto, ListAuditLogsQueryDto } from './dto/audit-log.dto.js';

@ApiTags('Organizations')
@Controller('orgs/:orgId/audit-logs')
export class AuditLogsController {
  constructor(private readonly repo: AuditLogsRepository) {}

  /**
   * Nhật ký thao tác quản trị của tổ chức, mới nhất trước (Admin trở lên).
   *
   * @remarks Lọc theo `action`, `actorId`. Log chỉ ghi thêm, không sửa/xoá được.
   */
  @Get()
  @RequireOrgPermission('org.audit.read')
  @ApiPaginatedResponse(AuditLogResponseDto)
  @ApiErrorResponses(400)
  async list(
    @Param('orgId') orgId: string,
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<Page<AuditLogResponseDto>> {
    const after = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
    const rows = await this.repo.list({
      orgId,
      action: query.action,
      actorId: query.actorId,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.createdAtKey, row.id]);
    return {
      data: page.data.map((row) => AuditLogResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }
}

/** Khoá thứ hai là id bigint (số), không phải uuid như các danh sách khác. */
function decodeAuditCursor(cursor: string): [string, number] {
  const [createdAtKey, id] = decodeCursor(cursor, 2);
  return [expectTimestampKey(createdAtKey), expectPositiveIntKey(id)];
}
