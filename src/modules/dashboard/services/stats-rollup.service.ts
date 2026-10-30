import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import { addDays } from '../../reports/report-week.js';
import { DashboardRepository } from '../repositories/dashboard.repository.js';

/** Trần số ngày một job được tính lại (job đêm dùng 35); chặn payload bất thường. */
export const MAX_ROLLUP_SPAN = 92;

/** Khoá advisory của (tổ chức, ngày) — export để test giữ đúng khoá này mà dựng tình huống tranh chấp. */
export function rollupLockKey(orgId: string, day: string): string {
  return `stats.rollup:${orgId}:${day}`;
}

/**
 * Tính lại rollup (M17 B2) — chạy trong worker, KHÔNG phụ thuộc BullMQ (processor chỉ gọi vào đây) nên
 * test được với Postgres thật.
 *
 * Tuần tự hoá theo (tổ chức, ngày) bằng khoá advisory mức transaction. Không có khoá: A đọc nguồn lúc
 * t1, nguồn đổi, B đọc lúc t2 > t1 rồi ghi TRƯỚC, sau đó A ghi ĐÈ số cũ lên số mới — rollup sai cho tới
 * lần tính lại kế tiếp. Có khoá: B chờ A commit rồi mới chạy câu `INSERT … SELECT` (READ COMMITTED lấy
 * snapshot MỚI ở đầu mỗi câu lệnh) nên luôn thấy nguồn mới nhất; hai bên không bao giờ ghi số cũ hơn số
 * đã ghi. Khoá theo (org, ngày) nên tổ chức / ngày khác không chờ nhau.
 */
@Injectable()
export class StatsRollupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: DashboardRepository,
  ) {}

  /** Tính lại `span` ngày kết thúc ở `day`, mỗi ngày một transaction ngắn (không giữ khoá cả loạt). */
  async rollup(orgId: string, day: string, span = 1): Promise<number> {
    const days = Math.min(Math.max(Math.trunc(span), 1), MAX_ROLLUP_SPAN);
    for (let i = 0; i < days; i++) await this.rollupDay(orgId, addDays(day, -i));
    return days;
  }

  async rollupDay(orgId: string, day: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // `hashtextextended` → bigint 64-bit (khó va chạm hơn `hashtext` 32-bit). Va chạm vẫn vô hại: chỉ
      // làm hai (org, ngày) khác nhau chờ nhau một chút.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${rollupLockKey(orgId, day)}, 0))`,
      );
      await this.repo.rollupDay(orgId, day, tx);
    });
  }
}
