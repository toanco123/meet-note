import { Injectable, type PipeTransform } from '@nestjs/common';
import { Errors } from '../../common/errors/errors.js';
import { isWeekStart } from './report-week.js';

/**
 * `:weekStart` trên path phải là THỨ HAI dạng `YYYY-MM-DD`. Ngày khác (Thứ Ba, 30/2, rác) → 400, không
 * phải 404: không có báo cáo nào có thể tồn tại cho giá trị đó (CHECK `weekly_reports_monday_ck`).
 */
@Injectable()
export class ParseWeekStartPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isWeekStart(value)) {
      throw Errors.common.validationFailed([
        { field: 'weekStart', message: 'Phải là ngày Thứ Hai dạng YYYY-MM-DD (vd 2026-10-05).' },
      ]);
    }
    return value;
  }
}
