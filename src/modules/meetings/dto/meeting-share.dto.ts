import { IsUUID } from 'class-validator';

export class ShareMeetingDto {
  /** Kênh muốn chia sẻ vào. Bạn phải là thành viên kênh (không phải khách). */
  @IsUUID()
  channelId: string;
}

export class MeetingShareResponseDto {
  meetingId: string;

  channelId: string;

  /** Lần chia sẻ ĐẦU TIÊN (chia sẻ lại không đổi). @example "2026-10-21T02:00:00.000Z" */
  sharedAt: string;
}
