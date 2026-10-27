import type {
  ChannelRoleValue,
  MeetingRow,
  MeetingStatus,
  OrgRoleValue,
} from '../../infra/database/schema/index.js';

/** Người đang xem meeting: đủ để quyết định quyền xem (04 §3) mà không cần đọc thêm gì. */
export interface MeetingViewer {
  userId: string;
  /** Vai trò trong org trên path (OrgMemberGuard đã tải) — Owner / Admin quản lý meeting không chủ. */
  orgRole: OrgRoleValue;
}

export interface ListVisibleMeetingsParams {
  orgId: string;
  viewer: MeetingViewer;
  /** Chỉ meeting share vào kênh này — service đã kiểm người xem đọc được nội dung kênh. */
  channelId?: string;
  status?: MeetingStatus;
  /** `recorded_at >= from`. */
  from?: Date;
  /** `recorded_at < to`. */
  to?: Date;
  /** Khoá cursor của dòng cuối trang trước: `(recorded_at, id)`, thời gian dạng text đủ micro giây. */
  after?: { recordedAt: string; id: string };
  limit: number;
}

/** Dòng danh sách: kèm khoá cursor `recorded_at` do Postgres in (không qua JS `Date`). */
export type MeetingListRow = MeetingRow & { recordedAtKey: string };

/** Kênh (chưa xoá) của org mà người xem THẤY nội dung (điều 2 / 3 của 04 §3) — M11 B5. */
export interface VisibleChannels {
  ids: string[];
  /** Tổng số kênh chưa xoá của org — chọn hình dạng luồng "qua kênh" (k² < K). */
  total: number;
}

/** Kênh chứa meeting mà người xem thấy được (metadata). */
export interface MeetingChannelRef {
  id: string;
  name: string;
}

/** Đủ để quyết định ai gỡ được meeting khỏi kênh — đọc từ các dòng VỪA KHOÁ. */
export interface UnshareContext {
  channelRole: ChannelRoleValue | null;
  orgRole: OrgRoleValue;
  channelArchived: boolean;
  isMeetingOwner: boolean;
  meetingOwnerless: boolean;
}

export interface ListChannelMeetingsParams {
  orgId: string;
  channelId: string;
  /** Khoá cursor dòng cuối trang trước: `(shared_at, meeting_id)`, thời gian dạng text. */
  after?: { sharedAt: string; meetingId: string };
  limit: number;
}

/** Meeting trong một kênh, kèm lúc share và khoá cursor do Postgres in. */
export type ChannelMeetingRow = MeetingRow & { sharedAt: Date; sharedAtKey: string };

/** Trường sửa được của meeting (PATCH). */
export interface MeetingPatch {
  title?: string;
  recordedAt?: Date;
}

/** Ba bước pipeline (M6), mỗi bước một job, retry độc lập (Q4). */
export type PipelineStep = 'preprocess' | 'transcribe' | 'summarize';

/** Payload job pipeline — CHỈ id + `attempt` (fencing, Q6) + request gốc để nối log. */
export interface PipelineJob {
  meetingId: string;
  attempt: number;
  requestId: string | null;
}

/** Xếp bước kế tiếp vào hàng đợi — gọi SAU commit (B5: BullMQ; test: bộ ghi). */
export interface PipelineScheduler {
  enqueue(step: PipelineStep, job: PipelineJob): Promise<void>;
}

export interface PipelineRunOptions {
  /** Worker tắt → huỷ process con / request đang chạy. */
  signal?: AbortSignal;
  onProgress?: (step: PipelineStep, percent: number) => void;
}

/** `done`: bước chạy xong và đã commit. `skipped`: job cũ / trùng / meeting đã xoá / mất lease. */
export type PipelineOutcome = 'done' | 'skipped';

export interface PipelineOptions {
  /** Meeting dài hơn → `MEDIA_TOO_LONG` (01-overview: ≤ 4 giờ). */
  maxDurationMs: number;
  /** ffprobe / ffmpeg mỗi lần chạy. */
  mediaTimeoutMs: number;
  /** Hạn whisper = thời lượng × hệ số + `transcribeBaseTimeoutMs`. */
  transcribeTimeoutFactor: number;
  transcribeBaseTimeoutMs: number;
  /** `auto` hoặc mã ngôn ngữ cho whisper. */
  language: string;
  /** Lease = thời gian tối đa một bước có thể chạy + dư; hết hạn thì worker khác được nhận. */
  preprocessLeaseMs: number;
  summarizeLeaseMs: number;
  leaseMarginMs: number;
}

/** Meeting vừa NHẬN VIỆC (claim) — đủ để chạy một bước, kèm token lease của lần nhận này. */
export interface ClaimedMeeting {
  id: string;
  orgId: string;
  ownerId: string | null;
  title: string;
  sourceObjectKey: string;
  audioObjectKey: string | null;
  durationMs: number | null;
  /** Ngày họp (để tóm tắt quy hạn "thứ sáu" ra ngày, M12). */
  recordedAt: Date;
  attempt: number;
  stageToken: string;
}

/** Meeting chưa xong, lâu không đổi và không ai giữ lease — ứng viên của quét kẹt (M6 B8). */
export interface StuckMeeting {
  id: string;
  status: MeetingStatus;
  attempt: number;
  /** `updated_at` dạng text (đủ micro giây) — keyset giữa các lô trong một lần quét. */
  updatedAt: string;
  /** `updated_at` tính bằng micro giây epoch — hậu tố jobId (`:` của timestamp bị BullMQ cấm). */
  version: string;
}

export interface SweepResult {
  /** Đã enqueue lại bước đúng trạng thái. */
  requeued: string[];
  /** Job thường của bước còn sống (chờ trong hàng / chờ retry / đang chạy) → để yên. */
  skipped: string[];
}
