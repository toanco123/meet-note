import { Injectable } from '@nestjs/common';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import type { ListMembersQueryDto } from './dto/list-members-query.dto.js';
import { MemberResponseDto } from './dto/member-response.dto.js';
import { OrganizationMembersRepository } from './organization-members.repository.js';

@Injectable()
export class OrganizationMembersService {
  constructor(private readonly repo: OrganizationMembersRepository) {}

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
}

/** Kiểm tra từng khoá trước khi chạm SQL — cursor bị sửa tay → 400, không phải 500. */
function decodeMemberCursor(cursor: string): [string, string] {
  const [joinedAtKey, userId] = decodeCursor(cursor, 2);
  return [expectTimestampKey(joinedAtKey), expectUuidKey(userId)];
}
