import { describe, expect, it } from 'vitest';
import type { MeetingSummaryRow } from '../../../../src/infra/database/schema/index.js';
import { MeetingSummaryResponseDto } from '../../../../src/modules/meetings/dto/meeting-summary.dto.js';

const row = (actionItems: unknown[], promptVersion: string): MeetingSummaryRow => ({
  meetingId: 'm',
  orgId: 'o',
  content: { overview: 'x', keyPoints: [], decisions: [], actionItems },
  model: 'fake',
  promptVersion,
  inputTokens: 0,
  outputTokens: 0,
  createdAt: new Date('2026-10-27T03:00:00Z'),
});

describe('MeetingSummaryResponseDto.from — dueDate (M12)', () => {
  it('tóm tắt v1 đã lưu (không có dueDate) → API trả dueDate null, không bỏ trống field', () => {
    const dto = MeetingSummaryResponseDto.from(
      row([{ owner: 'Bình', task: 't', due: 'thứ sáu' }], 'v1'),
    );
    expect(dto.actionItems).toEqual([{ owner: 'Bình', task: 't', due: 'thứ sáu', dueDate: null }]);
    expect(Object.keys(dto.actionItems[0]!)).toContain('dueDate');
  });

  it('tóm tắt v2 → giữ nguyên dueDate', () => {
    const dto = MeetingSummaryResponseDto.from(
      row([{ owner: null, task: 't', due: 'thứ sáu', dueDate: '2026-10-30' }], 'v2'),
    );
    expect(dto.actionItems[0]?.dueDate).toBe('2026-10-30');
    expect(dto.promptVersion).toBe('v2');
  });
});
