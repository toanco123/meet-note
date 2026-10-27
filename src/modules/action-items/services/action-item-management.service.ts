import { Inject, Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/errors.js';
import { findPgError, PG_FOREIGN_KEY_VIOLATION } from '../../../common/errors/pg-error.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import type { ActionItemRow } from '../../../infra/database/schema/index.js';
import { AuditService } from '../../audit/audit.service.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { canManageMeeting } from '../../meetings/meeting.policy.js';
import { MeetingsService } from '../../meetings/services/meetings.service.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import { decideActionItemWrite, requiresManager } from '../action-item.policy.js';
import { ActionItemsRepository } from '../action-items.repository.js';
import type { ActionItemPatch } from '../action-items.types.js';
import type { CreateActionItemDto } from '../dto/create-action-item.dto.js';
import { ActionItemResponseDto } from '../dto/action-item-response.dto.js';
import type { UpdateActionItemDto } from '../dto/update-action-item.dto.js';

/** Tên FK `(org_id, assignee_id) → organization_members` (migration 0018). */
const ASSIGNEE_FK = 'action_items_assignee_fk';

/**
 * Ghi việc cần làm (M12 B5): tạo tay và sửa bằng khoá lạc quan. Tách khỏi `ActionItemsService` (đọc)
 * vì hai bên có phụ thuộc khác nhau — ghi cần transaction + audit.
 */
@Injectable()
export class ActionItemManagementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ActionItemsRepository,
    private readonly meetings: MeetingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tạo việc tay — người QUẢN LÝ meeting (như sửa transcript). Không cần meeting `completed`: người ta
   * ghi việc ngay trong lúc pipeline còn chạy là chuyện bình thường, và việc tay không dính
   * `source_index` nên không đụng việc AI sắp được chèn.
   */
  async create(
    membership: OrgMembershipContext,
    ctx: UserAuditContext,
    meetingId: string,
    dto: CreateActionItemDto,
  ): Promise<ActionItemResponseDto> {
    const meeting = await this.meetings.assertVisible(membership, ctx.actorId, meetingId);
    if (!canManageMeeting(meeting, { userId: ctx.actorId, orgRole: membership.role })) {
      throw Errors.meeting.notManager();
    }
    const assigneeId = dto.assigneeId ?? null;
    if (assigneeId) await this.assertAssignable(membership.orgId, meetingId, assigneeId);

    const row = await this.guardAssigneeFk(() =>
      this.db.transaction(async (tx) => {
        const item = await this.repo.insertManual(
          {
            orgId: membership.orgId,
            meetingId,
            task: dto.task,
            assigneeId,
            dueDate: dto.dueDate ?? null,
            createdBy: ctx.actorId,
          },
          tx,
        );
        if (meeting.ownerId !== ctx.actorId) {
          await this.audit.record(tx, ctx, {
            orgId: membership.orgId,
            action: 'action_item.created',
            targetType: 'action_item',
            targetId: item.id,
            // Không ghi nội dung việc: audit sống lâu hơn việc.
            metadata: { meetingId },
          });
        }
        return (await this.repo.findListRow(item.id, tx))!;
      }),
    );
    return ActionItemResponseDto.from(row);
  }

  /**
   * Sửa một phần bằng `If-Match` (Q7). Thứ tự kiểm: body rỗng (400) → việc tồn tại và meeting xem được
   * (404, CÙNG một lỗi cho "không có" và "không xem được") → quyền (403) → người được giao (422) →
   * `UPDATE … WHERE version = $n` (412). Không khoá dòng: điều kiện `version` chính là khoá; quyết định
   * quyền dựa trên bản đọc ở đúng version client gửi, hoặc UPDATE thất bại.
   */
  async update(
    membership: OrgMembershipContext,
    ctx: UserAuditContext,
    itemId: string,
    expectedVersion: number,
    dto: UpdateActionItemDto,
  ): Promise<ActionItemResponseDto> {
    const patch = toPatch(dto);
    if (Object.keys(patch).length === 0) {
      throw Errors.common.validationFailed([
        { field: 'body', message: 'Cần ít nhất một trong: task, assigneeId, dueDate, status.' },
      ]);
    }
    const item = await this.repo.findById(itemId);
    const meeting =
      item && (await this.meetings.findVisible(membership, ctx.actorId, item.meetingId));
    if (!item || !meeting) throw Errors.actionItem.notFound();

    const viewer = { userId: ctx.actorId, orgRole: membership.role };
    if (decideActionItemWrite(item, patch, meeting, viewer) === 'forbidden') {
      throw Errors.actionItem.forbidden();
    }
    // Chỉ kiểm khi ĐỔI sang người khác: gửi lại đúng người đang được giao (đã mất quyền xem meeting
    // sau đó chẳng hạn) không được làm hỏng việc sửa các field khác.
    if (patch.assigneeId && patch.assigneeId !== item.assigneeId) {
      await this.assertAssignable(membership.orgId, item.meetingId, patch.assigneeId);
    }
    const auditable = requiresManager(item, patch) && meeting.ownerId !== ctx.actorId;

    const row = await this.guardAssigneeFk(() =>
      this.db.transaction(async (tx) => {
        const out = await this.repo.updateIfVersion(
          itemId,
          expectedVersion,
          patch,
          ctx.actorId,
          tx,
        );
        if (out.kind === 'not_found') throw Errors.actionItem.notFound();
        if (out.kind === 'version_mismatch') throw Errors.actionItem.versionMismatch();
        if (auditable) {
          await this.audit.record(tx, ctx, {
            orgId: membership.orgId,
            action: 'action_item.updated',
            targetType: 'action_item',
            targetId: itemId,
            metadata: changedFields(item, out.item, expectedVersion),
          });
        }
        return (await this.repo.findListRow(itemId, tx))!;
      }),
    );
    return ActionItemResponseDto.from(row);
  }

  private async assertAssignable(orgId: string, meetingId: string, userId: string): Promise<void> {
    if (!(await this.repo.canBeAssigned(orgId, meetingId, userId))) {
      throw Errors.actionItem.assigneeInvalid();
    }
  }

  /**
   * Người được giao rời org GIỮA lúc kiểm và lúc ghi: composite FK chặn (23503) — dữ liệu không bao giờ
   * trỏ vào người không còn là thành viên. Đổi thành 422 như kiểm trước, không để lọt 409 chung.
   */
  private async guardAssigneeFk<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const pg = findPgError(error);
      if (pg?.code === PG_FOREIGN_KEY_VIOLATION && pg.constraint === ASSIGNEE_FK) {
        throw Errors.actionItem.assigneeInvalid();
      }
      throw error;
    }
  }
}

function toPatch(dto: UpdateActionItemDto): ActionItemPatch {
  const patch: ActionItemPatch = {};
  if (dto.task !== undefined) patch.task = dto.task;
  if (dto.assigneeId !== undefined) patch.assigneeId = dto.assigneeId;
  if (dto.dueDate !== undefined) patch.dueDate = dto.dueDate;
  if (dto.status !== undefined) patch.status = dto.status;
  return patch;
}

/** Audit chỉ ghi TÊN field đã đổi + version, không ghi giá trị (nội dung việc có thể nhạy cảm). */
function changedFields(before: ActionItemRow, after: ActionItemRow, fromVersion: number) {
  const fields = (['task', 'assigneeId', 'dueDate', 'status'] as const).filter(
    (f) => before[f] !== after[f],
  );
  return { fields, fromVersion, toVersion: after.version };
}
