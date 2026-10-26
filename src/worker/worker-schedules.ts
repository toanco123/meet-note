import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobName } from '../infra/queue/jobs.js';
import { QueueName } from '../infra/queue/queue.module.js';

/** Bật / tắt đăng ký lịch lúc khởi động (env `WORKER_SCHEDULES_ENABLED`; test ghi đè token này). */
export const WORKER_SCHEDULES_ENABLED = Symbol('WORKER_SCHEDULES_ENABLED');

const TZ = 'Asia/Ho_Chi_Minh';

/**
 * Lịch chạy của hệ thống. Dùng CRON (`pattern` + `tz`) cho mọi lịch: purge kênh cần MỐC GIỜ trong ngày
 * (03:00 giờ Việt Nam) nên bắt buộc cron; các lịch "mỗi N phút" dùng cùng kiểu để chạy đúng :00 / :05.
 * (`every` thì mốc tính từ lúc TẠO lịch, và lần tạo đầu chạy NGAY — Lua `addJobScheduler`; upsert lại
 * khi worker khởi động giữ nguyên mốc cũ, không kích thêm lượt.)
 */
export const SCHEDULES = [
  { id: 'meeting-sweep-stuck', pattern: '*/5 * * * *', name: JobName.MeetingSweepStuck },
  { id: 'upload-cleanup', pattern: '*/10 * * * *', name: JobName.UploadCleanup },
  { id: 'idempotency-cleanup', pattern: '*/10 * * * *', name: JobName.IdempotencyCleanup },
  { id: 'channel-purge', pattern: '0 3 * * *', name: JobName.ChannelPurge },
  // 08:00 Thứ Hai giờ VN: báo cáo của TUẦN TRƯỚC (D8). Cron có `tz` để BullMQ tính đúng mốc.
  { id: 'weekly-report-tick', pattern: '0 8 * * 1', name: JobName.WeeklyReportTick },
] as const;

/**
 * Đăng ký lịch vào queue `default` (M6 B8) bằng Job Scheduler của BullMQ — KHÔNG dùng
 * `@nestjs/schedule`: cron trong tiến trình chạy ở MỌI instance (2 worker → dọn 2 lần). Scheduler
 * nằm trong Redis, khoá theo id: nhiều worker cùng upsert vẫn một lịch, và mỗi mốc giờ chỉ sinh MỘT
 * job (id job do BullMQ tính từ id lịch + mốc giờ).
 */
@Injectable()
export class WorkerSchedules implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerSchedules.name);

  constructor(
    @InjectQueue(QueueName.Default) private readonly queue: Queue,
    @Inject(WORKER_SCHEDULES_ENABLED) private readonly enabled: boolean,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) await this.register();
  }

  /**
   * Khai báo kiểu "trạng thái mong muốn": upsert lịch đang có, XOÁ lịch không còn trong danh sách
   * (đổi tên / bỏ một lịch ở bản deploy sau không để lại lịch mồ côi chạy mãi trong Redis).
   */
  async register(): Promise<void> {
    const wanted = new Set<string>(SCHEDULES.map((s) => s.id));
    for (const s of SCHEDULES) {
      await this.queue.upsertJobScheduler(
        s.id,
        { pattern: s.pattern, tz: TZ },
        { name: s.name, data: {} },
      );
    }
    for (const existing of await this.queue.getJobSchedulers()) {
      if (!wanted.has(existing.key)) {
        await this.queue.removeJobScheduler(existing.key);
        this.logger.warn({ scheduler: existing.key }, 'Xoá lịch không còn khai báo');
      }
    }
    this.logger.log({ schedules: [...wanted] }, 'Đã đăng ký lịch chạy');
  }
}
