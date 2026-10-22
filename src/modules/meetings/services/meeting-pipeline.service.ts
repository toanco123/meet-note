import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import type {
  MeetingFailureCode,
  MeetingStatus,
  NotificationRow,
} from '../../../infra/database/schema/index.js';
import { LlmPermanentError } from '../../../infra/llm/llm.errors.js';
import { SUMMARIZER } from '../../../infra/llm/llm.module.js';
import type { MeetingSummaryContent, Summarizer } from '../../../infra/llm/llm.types.js';
import { MediaConversionError, MediaUnreadableError } from '../../../infra/media/media.errors.js';
import { MediaTools } from '../../../infra/media/media-tools.js';
import { SpeechModelMissingError } from '../../../infra/speech/speech.errors.js';
import { SPEECH_TO_TEXT } from '../../../infra/speech/speech.module.js';
import type { SpeechToText } from '../../../infra/speech/speech.types.js';
import { RealtimeRoom } from '../../../infra/realtime/realtime-rooms.js';
import { REALTIME_PUBLISHER } from '../../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../infra/realtime/realtime.types.js';
import { ObjectNotFoundError } from '../../../infra/storage/storage.errors.js';
import { OBJECT_STORAGE } from '../../../infra/storage/storage.module.js';
import type { ObjectStorage } from '../../../infra/storage/storage.types.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import { publishMeetingStatus } from '../meeting-events.js';
import { PermanentPipelineError } from '../meeting-pipeline.errors.js';
import type {
  ClaimedMeeting,
  PipelineJob,
  PipelineOptions,
  PipelineOutcome,
  PipelineRunOptions,
  PipelineScheduler,
  PipelineStep,
} from '../meetings.types.js';
import { PIPELINE_OPTIONS, PIPELINE_SCHEDULER } from '../pipeline.tokens.js';
import { MeetingPipelineRepository } from '../repositories/meeting-pipeline.repository.js';

/** Transcript rỗng (im lặng / không nhận dạng được) → không gọi LLM. */
const EMPTY_SUMMARY: MeetingSummaryContent = {
  overview: 'Không nhận dạng được lời nói trong bản ghi.',
  keyPoints: [],
  decisions: [],
  actionItems: [],
};

/**
 * Ba bước của pipeline (M6 B4), KHÔNG phụ thuộc BullMQ (processor B5 chỉ gọi vào đây) → test được
 * với Postgres + RustFS + ffmpeg thật và speech / LLM giả.
 *
 * Mỗi bước: (1) NHẬN VIỆC bằng lease (`claim`) — job cũ / trùng / meeting đã xoá → `skipped`;
 * (2) việc chạy lâu NGOÀI transaction (S3, ffmpeg, whisper, LLM — giữ transaction thì còn bị
 * `idle_in_transaction_session_timeout` cắt); (3) MỘT transaction ngắn: chuyển chặng trước (có kiểm
 * token — mất lease thì không ghi kết quả), rồi ghi kết quả kiểu thay thế; (4) SAU commit mới
 * enqueue bước kế. Lỗi ở bất kỳ đâu → nhả lease rồi ném ra (vĩnh viễn: `PermanentPipelineError`).
 */
@Injectable()
export class MeetingPipelineService {
  private readonly logger = new Logger(MeetingPipelineService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: MeetingPipelineRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly media: MediaTools,
    @Inject(SPEECH_TO_TEXT) private readonly speech: SpeechToText,
    @Inject(SUMMARIZER) private readonly summarizer: Summarizer,
    @Inject(PIPELINE_SCHEDULER) private readonly scheduler: PipelineScheduler,
    @Inject(PIPELINE_OPTIONS) private readonly options: PipelineOptions,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
    private readonly notifications: NotificationsService,
  ) {}

  /** Tải file gốc (kiểm sha256 trong lúc tải) → probe → WAV 16 kHz mono → đẩy lên S3. */
  async preprocess(job: PipelineJob, run: PipelineRunOptions = {}): Promise<PipelineOutcome> {
    const lease = this.options.preprocessLeaseMs;
    const meeting = await this.repo.claim(
      job.meetingId,
      job.attempt,
      ['queued', 'preprocessing'],
      'preprocessing',
      lease,
    );
    if (!meeting) return this.skip('preprocess', job);
    // `queued` → `preprocessing` vừa commit (câu claim tự commit). Lần retry phát lại cùng trạng
    // thái — vô hại, client xử lý idempotent.
    this.publishStatus(meeting, 'preprocessing');
    return this.runStage('preprocess', meeting, job, () =>
      withTempDir(async (dir) => {
        const source = join(dir, 'source');
        const downloaded = await this.storage
          .downloadToFile(meeting.sourceObjectKey, source, run.signal)
          .catch((error: unknown) => {
            if (error instanceof ObjectNotFoundError) {
              throw new PermanentPipelineError('MEDIA_UNREADABLE', 'Không tìm thấy file gốc.', {
                cause: error,
              });
            }
            throw error;
          });
        const expected = await this.repo.expectedSha256(meeting.id);
        if (expected && expected !== downloaded.sha256) {
          throw new PermanentPipelineError(
            'SOURCE_CHECKSUM_MISMATCH',
            'File tải lên không khớp với file gốc (sai checksum).',
          );
        }
        const mediaRun = { timeoutMs: this.options.mediaTimeoutMs, signal: run.signal };
        const probe = await this.media.probe(source, mediaRun).catch(asMediaPermanent);
        if (!probe.hasAudio) {
          throw new PermanentPipelineError('MEDIA_NO_AUDIO', 'File không có âm thanh.');
        }
        if (probe.durationMs > this.options.maxDurationMs) {
          throw new PermanentPipelineError('MEDIA_TOO_LONG', 'Bản ghi dài quá giới hạn cho phép.');
        }
        const wav = join(dir, 'audio.wav');
        await this.media.toWav16kMono(source, wav, mediaRun).catch(asMediaPermanent);
        // Khoá ổn định theo meeting: chạy lại GHI ĐÈ cùng object, không để lại bản thừa.
        const audioObjectKey = `orgs/${meeting.orgId}/meetings/${meeting.id}/audio.wav`;
        await this.storage.uploadFile(audioObjectKey, wav, 'audio/wav', run.signal);
        return this.db.transaction(async (tx) =>
          (await this.repo.completePreprocess(tx, meeting.id, meeting.stageToken, {
            durationMs: probe.durationMs,
            audioObjectKey,
          }))
            ? []
            : false,
        );
      }),
    );
  }

  /** whisper trên audio chuẩn hoá → thay toàn bộ đoạn transcript. */
  async transcribe(job: PipelineJob, run: PipelineRunOptions = {}): Promise<PipelineOutcome> {
    // Lease theo độ dài audio: whisper chạy lâu tương ứng (lấy từ lần preprocess đã ghi).
    const timeoutMs = await this.transcribeTimeout(job.meetingId);
    const meeting = await this.repo.claim(
      job.meetingId,
      job.attempt,
      ['transcribing'],
      'transcribing',
      timeoutMs + this.options.leaseMarginMs,
    );
    if (!meeting) return this.skip('transcribe', job);
    return this.runStage('transcribe', meeting, job, () =>
      withTempDir(async (dir) => {
        if (!meeting.audioObjectKey) throw new Error('Meeting ở chặng transcribe mà thiếu audio');
        const wav = join(dir, 'audio.wav');
        await this.storage.downloadToFile(meeting.audioObjectKey, wav, run.signal);
        // whisper báo tiến độ dày (mỗi vài %) → chỉ phát khi tăng ≥ 5 % hoặc tới 100 %: đủ cho thanh
        // tiến độ, không dội Redis / socket mỗi dòng stderr.
        let lastSent = -Infinity;
        const onProgress = (percent: number) => {
          if (percent - lastSent < 5 && !(percent === 100 && lastSent !== 100)) return;
          lastSent = percent;
          run.onProgress?.('transcribe', percent);
          this.realtime.emit([RealtimeRoom.meeting(meeting.id)], 'meeting.progress', {
            meetingId: meeting.id,
            stage: 'transcribe',
            percent,
          });
        };
        const transcript = await this.speech
          .transcribe(wav, {
            language: this.options.language,
            timeoutMs,
            signal: run.signal,
            onProgress,
          })
          .catch((error: unknown) => {
            if (error instanceof SpeechModelMissingError) {
              throw new PermanentPipelineError(
                'TRANSCRIBE_FAILED',
                'Hệ thống nhận dạng giọng nói chưa sẵn sàng.',
                {
                  cause: error,
                },
              );
            }
            throw error; // whisper lỗi / quá hạn: tạm — thử lại
          });
        return this.db.transaction(async (tx) => {
          // Chuyển chặng TRƯỚC (kiểm token): mất lease → không động vào đoạn transcript.
          if (
            !(await this.repo.completeTranscribe(
              tx,
              meeting.id,
              meeting.stageToken,
              transcript.language,
            ))
          ) {
            return false;
          }
          await this.repo.replaceSegments(tx, meeting, transcript.segments);
          return [];
        });
      }),
    );
  }

  /** LLM tóm tắt transcript → upsert tóm tắt → `completed`. */
  async summarize(job: PipelineJob, run: PipelineRunOptions = {}): Promise<PipelineOutcome> {
    const meeting = await this.repo.claim(
      job.meetingId,
      job.attempt,
      ['summarizing'],
      'summarizing',
      this.options.summarizeLeaseMs,
    );
    if (!meeting) return this.skip('summarize', job);
    return this.runStage('summarize', meeting, job, async () => {
      const segments = await this.repo.segmentsOf(meeting.id);
      const summary =
        segments.length === 0
          ? {
              content: EMPTY_SUMMARY,
              model: 'none',
              promptVersion: 'none',
              inputTokens: 0,
              outputTokens: 0,
            }
          : await this.summarizer
              .summarize({ meetingTitle: meeting.title, segments }, { signal: run.signal })
              .catch((error: unknown) => {
                if (error instanceof LlmPermanentError) {
                  throw new PermanentPipelineError(
                    'SUMMARIZE_FAILED',
                    'Không tạo được bản tóm tắt.',
                    {
                      cause: error,
                    },
                  );
                }
                throw error;
              });
      return this.db.transaction(async (tx) => {
        if (!(await this.repo.completeSummarize(tx, meeting.id, meeting.stageToken))) return false;
        await this.repo.upsertSummary(tx, meeting, summary);
        // Một người nhận (chủ) → ghi TRONG transaction như M10 Q2: rollback thì không có thông báo "ma".
        return meeting.ownerId
          ? this.notifications.recordInTx(tx, [
              {
                userId: meeting.ownerId,
                orgId: meeting.orgId,
                type: 'meeting.completed',
                payload: { meetingId: meeting.id, meetingTitle: meeting.title },
                dedupeKey: `meeting-completed.${meeting.id}.a${meeting.attempt}`,
              },
            ])
          : [];
      });
    });
  }

  /**
   * Đưa meeting về `failed` (processor B5): lỗi vĩnh viễn, hoặc hết lượt retry. Điều kiện `attempt`:
   * sự kiện của lần chạy cũ tới muộn không đè lên lần chạy lại. Chủ nhận `meeting.failed` (M6 Q7)
   * trong CÙNG transaction; realtime + thông báo đẩy sau commit.
   */
  async fail(job: PipelineJob, code: MeetingFailureCode, message: string): Promise<boolean> {
    const result = await this.db.transaction(async (tx) => {
      const failed = await this.repo.fail(tx, job.meetingId, job.attempt, code, message);
      if (!failed) return undefined;
      const rows = failed.ownerId
        ? await this.notifications.recordInTx(tx, [
            {
              userId: failed.ownerId,
              orgId: failed.orgId,
              type: 'meeting.failed',
              payload: { meetingId: job.meetingId, meetingTitle: failed.title, failureCode: code },
              dedupeKey: `meeting-failed.${job.meetingId}.a${job.attempt}`,
            },
          ])
        : [];
      return { failed, rows };
    });
    if (!result) return false;
    this.notifications.publish(result.rows);
    publishMeetingStatus(this.realtime, {
      id: job.meetingId,
      ownerId: result.failed.ownerId,
      status: 'failed',
      failureCode: code,
    });
    return true;
  }

  /**
   * Chạy thân một bước. Thân trả `false` = mất lease giữa chừng (worker khác đã nhận) → bỏ qua, không
   * phát, không enqueue; ngược lại trả các thông báo đã ghi trong transaction để đẩy SAU commit.
   * Lỗi → nhả lease (retry nhận lại ngay) rồi ném tiếp.
   */
  private async runStage(
    step: PipelineStep,
    meeting: ClaimedMeeting,
    job: PipelineJob,
    body: () => Promise<NotificationRow[] | false>,
  ): Promise<PipelineOutcome> {
    let committed: NotificationRow[] | false;
    try {
      committed = await body();
    } catch (error) {
      await this.repo
        .release(meeting.id, meeting.stageToken)
        .catch((releaseError: unknown) =>
          this.logger.error({ err: releaseError, meetingId: meeting.id }, 'Nhả lease lỗi'),
        );
      throw error;
    }
    if (!committed) {
      this.logger.warn(
        { meetingId: meeting.id, step, requestId: job.requestId },
        'Mất lease — bỏ kết quả',
      );
      return 'skipped';
    }
    // SAU commit: trạng thái mới + thông báo (đẩy trong transaction mà rollback → client thấy "ma").
    this.publishStatus(meeting, STATUS_AFTER[step]);
    this.notifications.publish(committed);
    const next = NEXT_STEP[step];
    if (next) {
      // Enqueue lỗi (Redis sập) không làm hỏng bước đã commit: quét meeting kẹt (B8) sẽ enqueue lại.
      await this.scheduler
        .enqueue(next, job)
        .catch((error: unknown) =>
          this.logger.error({ err: error, meetingId: meeting.id, next }, 'Enqueue bước kế lỗi'),
        );
    }
    return 'done';
  }

  private publishStatus(meeting: ClaimedMeeting, status: MeetingStatus): void {
    publishMeetingStatus(this.realtime, {
      id: meeting.id,
      ownerId: meeting.ownerId,
      status,
      failureCode: null,
    });
  }

  private skip(step: PipelineStep, job: PipelineJob): PipelineOutcome {
    this.logger.log(
      { ...job, step },
      'Bỏ qua: job cũ / trùng / meeting đã xoá / đang có người giữ',
    );
    return 'skipped';
  }

  private async transcribeTimeout(meetingId: string): Promise<number> {
    const durationMs = (await this.repo.durationOf(meetingId)) ?? this.options.maxDurationMs;
    return Math.round(
      durationMs * this.options.transcribeTimeoutFactor + this.options.transcribeBaseTimeoutMs,
    );
  }
}

/** Chặng sau khi một bước commit (06 §1.2: `status` là chặng). */
const STATUS_AFTER: Record<PipelineStep, MeetingStatus> = {
  preprocess: 'transcribing',
  transcribe: 'summarizing',
  summarize: 'completed',
};

const NEXT_STEP: Record<PipelineStep, PipelineStep | undefined> = {
  preprocess: 'transcribe',
  transcribe: 'summarize',
  summarize: undefined,
};

/** ffprobe không đọc được / ffmpeg không giải mã được file → lỗi của FILE, chạy lại vẫn vậy. */
function asMediaPermanent(error: unknown): never {
  if (error instanceof MediaUnreadableError || error instanceof MediaConversionError) {
    throw new PermanentPipelineError('MEDIA_UNREADABLE', 'Không đọc được file ghi âm.', {
      cause: error,
    });
  }
  throw error;
}

/** Thư mục tạm riêng cho một lần chạy, LUÔN xoá (kể cả khi lỗi / bị huỷ). */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'meetnote-pipeline-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
