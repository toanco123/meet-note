# Ví dụ module: danh sách thành viên kênh

Ví dụ minh hoạ cách các lớp ghép với nhau, dùng đúng các helper có sẵn trong repo:

- `Errors` (catalog lỗi, `src/common/errors/errors.ts`), `ErrorCode`
- `CursorQueryDto`, `toPage`, `decodeCursor`
- `ApiErrorResponses`, `ApiPaginatedResponse`
- `DRIZZLE`, `DbExecutor`

Guard và decorator quyền (`ChannelAccessGuard`, `@Require`, `@CurrentUser`) sẽ được tạo ở M1/M2, xem skill `authorization`. Tên bảng/cột lấy theo `docs/design/03-database.md`.

## dto/list-channel-members-query.dto.ts

```ts
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import { ChannelRole } from '../channel-role.js';

export class ListChannelMembersQueryDto extends CursorQueryDto {
  /** Tìm theo tên hoặc email, không phân biệt dấu. @example "nguyen van" */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Lọc theo vai trò trong kênh. */
  @IsOptional()
  @IsEnum(ChannelRole)
  role?: ChannelRole;
}
```

## dto/channel-member-response.dto.ts

```ts
import { ApiProperty } from '@nestjs/swagger';
import { ChannelRole } from '../channel-role.js';

export class ChannelMemberResponseDto {
  userId: string;

  /** @example "Nguyễn Văn A" */
  displayName: string;

  @ApiProperty({ enum: ChannelRole, enumName: 'ChannelRole' })
  role: ChannelRole;

  /** Thời điểm tham gia kênh (ISO 8601). */
  joinedAt: string;
}
```

## channel-members.repository.ts

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { channelMembers, users } from '../../infra/database/schema/index.js';

export interface MemberRow {
  userId: string;
  displayName: string;
  role: string;
  joinedAt: string; // text từ DB — giữ đủ micro giây cho cursor
}

@Injectable()
export class ChannelMembersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Lấy `limit + 1` dòng để service biết còn trang sau. */
  async list(
    params: { channelId: string; q?: string; after?: [string, string]; limit: number },
    executor: DbExecutor = this.db,
  ): Promise<MemberRow[]> {
    const { channelId, q, after, limit } = params;
    return executor
      .select({
        userId: channelMembers.userId,
        displayName: users.displayName,
        role: channelMembers.role,
        joinedAt: sql<string>`${channelMembers.joinedAt}::text`,
      })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          q ? sql`${users.searchText} like '%' || f_unaccent(lower(${q})) || '%'` : undefined,
          after
            ? sql`(${channelMembers.joinedAt}, ${channelMembers.userId}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.userId))
      .limit(limit + 1);
  }
}
```

## channel-members.service.ts

```ts
import { Injectable } from '@nestjs/common';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import type { ChannelRole } from './channel-role.js';
import { ChannelMembersRepository, type MemberRow } from './channel-members.repository.js';
import type { ChannelMemberResponseDto } from './dto/channel-member-response.dto.js';
import type { ListChannelMembersQueryDto } from './dto/list-channel-members-query.dto.js';

@Injectable()
export class ChannelMembersService {
  // Import GIÁ TRỊ (không `import type`) vì Nest inject theo kiểu constructor.
  constructor(private readonly repo: ChannelMembersRepository) {}

  async list(
    channelId: string,
    query: ListChannelMembersQueryDto,
  ): Promise<Page<ChannelMemberResponseDto>> {
    const after = query.cursor ? (decodeCursor(query.cursor, 2) as [string, string]) : undefined;
    const rows = await this.repo.list({ channelId, q: query.q, after, limit: query.limit });
    const page = toPage(rows, query.limit, (r) => [r.joinedAt, r.userId]);
    return { ...page, data: page.data.map(toResponse) };
  }
}

function toResponse(row: MemberRow): ChannelMemberResponseDto {
  return {
    userId: row.userId,
    displayName: row.displayName,
    role: row.role as ChannelRole,
    joinedAt: new Date(row.joinedAt).toISOString(),
  };
}
```

## channels.controller.ts (phần danh sách thành viên)

```ts
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import type { Page } from '../../common/pagination/cursor.js';
import { ChannelMembersService } from './channel-members.service.js';
import { ChannelMemberResponseDto } from './dto/channel-member-response.dto.js';
import { ListChannelMembersQueryDto } from './dto/list-channel-members-query.dto.js';

@ApiTags('Channels')
@Controller('orgs/:orgId/channels/:channelId/members')
export class ChannelMembersController {
  constructor(private readonly members: ChannelMembersService) {}

  /**
   * Danh sách thành viên kênh.
   *
   * @remarks Phân trang cursor, tìm không dấu theo tên/email. Guest không được gọi.
   */
  @Get()
  @ApiPaginatedResponse(ChannelMemberResponseDto)
  @ApiErrorResponses(400, 401, 403, 404)
  list(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query() query: ListChannelMembersQueryDto,
  ): Promise<Page<ChannelMemberResponseDto>> {
    return this.members.list(channelId, query);
  }
}
```

## Test

- `test/unit/modules/channels/channel.policy.spec.ts`: `it.each` theo ma trận quyền.
- `test/e2e/channel-members.e2e-spec.ts`:
  - phân trang qua 2 trang không trùng/mất dòng;
  - `?q=nguyen` khớp "Nguyễn";
  - cursor hỏng → 400 `INVALID_CURSOR`;
  - Guest → 403;
  - người ngoài kênh riêng tư → 404.
