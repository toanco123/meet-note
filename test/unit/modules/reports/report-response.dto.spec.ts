import { describe, expect, it } from 'vitest';
import type { WeeklyReportVersionRow } from '../../../../src/infra/database/schema/index.js';
import { ReportVersionResponseDto } from '../../../../src/modules/reports/dto/report-response.dto.js';

const row = (content: Record<string, unknown>): WeeklyReportVersionRow =>
  ({
    version: 1,
    trigger: 'scheduled',
    triggeredBy: null,
    truncated: false,
    model: 'fake',
    createdAt: new Date('2026-10-12T01:00:00Z'),
    content,
  }) as unknown as WeeklyReportVersionRow;

describe('ReportVersionResponseDto.from — việc quá hạn (M12)', () => {
  // Đột biến: bỏ `?? []` / `?? false` → báo cáo tạo trước M12 trả undefined (client vỡ khi .map).
  it('báo cáo lưu TRƯỚC M12 (jsonb không có hai field) → mặc định rỗng, các field khác nguyên vẹn', () => {
    const dto = ReportVersionResponseDto.from(
      row({ overview: 'Cũ', highlights: ['a'], decisions: [], actionItems: [], meetings: [] }),
    );
    expect(dto.content.overdueActionItems).toEqual([]);
    expect(dto.content.overdueActionItemsTruncated).toBe(false);
    expect(dto.content.overview).toBe('Cũ');
    expect(dto.content.highlights).toEqual(['a']);
  });

  it('báo cáo mới giữ nguyên danh sách và cờ truncated', () => {
    const item = {
      id: 'i1',
      task: 'Gửi báo giá',
      assignee: 'Bình',
      dueDate: '2026-10-02',
      meetingId: 'm1',
      meetingTitle: 'Họp',
    };
    const dto = ReportVersionResponseDto.from(
      row({ overview: 'Mới', overdueActionItems: [item], overdueActionItemsTruncated: true }),
    );
    expect(dto.content.overdueActionItems).toEqual([item]);
    expect(dto.content.overdueActionItemsTruncated).toBe(true);
  });
});
