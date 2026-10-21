import { ApiProperty } from '@nestjs/swagger';
import {
  MEETING_STATUSES,
  type MeetingRow,
  type MeetingStatus,
} from '../../../infra/database/schema/index.js';

export class MeetingResponseDto {
  id: string;

  /** @example "Giao ban kỹ thuật tuần 42" */
  title: string;

  /** `queued` → chờ xử lý (M6 chạy ffmpeg / Whisper / tóm tắt). */
  @ApiProperty({ enum: MEETING_STATUSES, enumName: 'MeetingStatus' })
  status: MeetingStatus;

  @ApiProperty({ type: String, nullable: true, description: '`null` = chủ đã rời tổ chức.' })
  ownerId: string | null;

  /** @example "2026-10-19T02:00:00.000Z" */
  recordedAt: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Độ dài (ms), có sau khi xử lý.' })
  durationMs: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'Ngôn ngữ Whisper phát hiện.' })
  language: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Mã lỗi khi `status = failed`.' })
  failureCode: string | null;

  /** @example "2026-10-19T02:05:00.000Z" */
  createdAt: string;

  static from(row: MeetingRow): MeetingResponseDto {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      ownerId: row.ownerId,
      recordedAt: row.recordedAt.toISOString(),
      durationMs: row.durationMs,
      language: row.language,
      failureCode: row.failureCode,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export class MeetingChannelRefDto {
  id: string;

  /** @example "Kỹ thuật" */
  name: string;
}

/** Chi tiết: thêm các kênh chứa meeting mà người gọi thấy được. */
export class MeetingDetailResponseDto extends MeetingResponseDto {
  channels: MeetingChannelRefDto[];

  static withChannels(row: MeetingRow, channels: MeetingChannelRefDto[]): MeetingDetailResponseDto {
    return { ...MeetingResponseDto.from(row), channels };
  }
}

/** Một dòng của danh sách meeting trong kênh. */
export class ChannelMeetingResponseDto extends MeetingResponseDto {
  /** Lúc được chia sẻ vào kênh này. @example "2026-10-21T02:00:00.000Z" */
  sharedAt: string;

  static fromShared(row: MeetingRow & { sharedAt: Date }): ChannelMeetingResponseDto {
    return { ...MeetingResponseDto.from(row), sharedAt: row.sharedAt.toISOString() };
  }
}
