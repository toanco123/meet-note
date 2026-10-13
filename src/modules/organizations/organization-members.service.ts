import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, Transaction } from '../../infra/database/database.types.js';
import type { ListMembersQueryDto } from './dto/list-members-query.dto.js';
import { MemberResponseDto } from './dto/member-response.dto.js';
import type { AssignableOrgRole } from './dto/update-member-role.dto.js';
import { canChangeRole, type TargetDecision } from './organization.policy.js';
import { OrganizationMembersRepository } from './organization-members.repository.js';

@Injectable()
export class OrganizationMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: OrganizationMembersRepository,
  ) {}

  async list(orgId: string, query: ListMembersQueryDto): Promise<Page<MemberResponseDto>> {
    const after = query.cursor ? decodeMemberCursor(query.cursor) : undefined;
    const rows = await this.repo.list({
      orgId,
      q: query.q,
      role: query.role,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.joinedAtKey, row.userId]);
    return {
      data: page.data.map((row) => MemberResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Mẫu "đổi quyền": khoá (actor, target) theo thứ tự → kiểm tra LẠI bằng policy trên dữ liệu
   * vừa khoá (guard đọc lúc đầu có thể đã cũ) → ghi. Mọi lỗi xảy ra TRƯỚC lệnh ghi nên ném
   * ngay trong transaction là an toàn (khác `SessionsService.rotate`, nơi có ghi rồi mới báo lỗi).
   */
  async changeRole(
    orgId: string,
    actorId: string,
    targetId: string,
    newRole: AssignableOrgRole,
  ): Promise<MemberResponseDto> {
    await this.db.transaction(async (tx) => {
      const { actor, target } = await this.lockActorAndTarget(orgId, actorId, targetId, tx);
      assertAllowed(canChangeRole(actor, target, newRole));
      await this.repo.updateRole(orgId, targetId, newRole, tx);
    });

    const updated = await this.repo.findMember(orgId, targetId);
    if (!updated) throw memberNotFound(); // bị gỡ ngay sau khi commit — hiếm, nhưng đừng trả 500
    return MemberResponseDto.from(updated);
  }

  private async lockActorAndTarget(
    orgId: string,
    actorId: string,
    targetId: string,
    tx: Transaction,
  ) {
    const rows = await this.repo.lockMembers(orgId, [actorId, targetId], tx);
    const actor = rows.find((r) => r.userId === actorId)?.role;
    const target = rows.find((r) => r.userId === targetId)?.role;
    // Actor vừa bị gỡ bởi request khác (sau khi guard đã cho qua) → coi như không còn là thành viên.
    if (!actor) throw AppException.notFound('Không tìm thấy tổ chức.');
    if (!target) throw memberNotFound();
    return { actor, target };
  }
}

function assertAllowed(decision: TargetDecision): void {
  if (decision === 'owner_immutable') {
    throw new AppException(
      ErrorCode.OrgOwnerImmutable,
      HttpStatus.CONFLICT,
      'Không thể đổi vai trò hoặc gỡ Owner. Hãy chuyển quyền sở hữu trước.',
    );
  }
  if (decision === 'forbidden') {
    throw AppException.forbidden('Vai trò của bạn không được tác động lên thành viên này.');
  }
}

function memberNotFound(): AppException {
  return AppException.notFound('Không tìm thấy thành viên trong tổ chức.');
}

/** Kiểm tra từng khoá trước khi chạm SQL — cursor bị sửa tay → 400, không phải 500. */
function decodeMemberCursor(cursor: string): [string, string] {
  const [joinedAtKey, userId] = decodeCursor(cursor, 2);
  return [expectTimestampKey(joinedAtKey), expectUuidKey(userId)];
}
