import { ApiProperty } from '@nestjs/swagger';
import type { MeetingSummaryRow } from '../../../infra/database/schema/index.js';
import type { MeetingSummaryContent } from '../../../infra/llm/llm.types.js';

export class ActionItemDto {
  @ApiProperty({ type: String, nullable: true, description: 'Người nhận việc (nếu được nói rõ).' })
  owner: string | null;

  /** @example "Chuẩn bị ngân sách marketing" */
  task: string;

  @ApiProperty({ type: String, nullable: true, description: 'Hạn như được nói, vd "thứ sáu".' })
  due: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Hạn đã quy ra ngày (YYYY-MM-DD, theo ngày họp). null nếu không có hạn rõ ràng hoặc tóm tắt tạo bằng phiên bản prompt cũ.',
    example: '2026-10-30',
  })
  dueDate: string | null;
}

/** Tóm tắt AI của cuộc họp (M6). */
export class MeetingSummaryResponseDto {
  /** @example "Họp chốt kế hoạch quý ba và phân công chuẩn bị ngân sách." */
  overview: string;

  keyPoints: string[];

  decisions: string[];

  @ApiProperty({ type: [ActionItemDto] })
  actionItems: ActionItemDto[];

  /** Model đã tạo bản tóm tắt (có thể là model dự phòng). @example "claude-opus-5-5" */
  model: string;

  /** @example "v2" */
  promptVersion: string;

  /** @example "2026-10-22T03:00:00.000Z" */
  createdAt: string;

  static from(row: MeetingSummaryRow): MeetingSummaryResponseDto {
    const content = row.content as unknown as MeetingSummaryContent;
    return {
      overview: content.overview,
      keyPoints: content.keyPoints,
      decisions: content.decisions,
      // Tóm tắt `v1` đã lưu không có `dueDate`.
      actionItems: content.actionItems.map((i) => ({ ...i, dueDate: i.dueDate ?? null })),
      model: row.model,
      promptVersion: row.promptVersion,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
