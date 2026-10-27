import type { MeetingSummaryContent, SummaryInput } from './llm.types.js';

/** Đổi prompt / schema → tăng phiên bản (lưu ở `meeting_summaries.prompt_version`). */
export const PROMPT_VERSION = 'v2';

/**
 * JSON Schema cho structured outputs (`output_config.format`). Giới hạn của API: mọi object phải có
 * `additionalProperties: false`; KHÔNG có `minLength` / `maximum` (ràng buộc đó kiểm ở
 * `parseSummaryContent`); "có thể trống" viết bằng `anyOf` với `null`.
 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'keyPoints', 'decisions', 'actionItems'],
  properties: {
    overview: { type: 'string', description: 'Tóm tắt 2–4 câu: cuộc họp bàn gì, kết quả chính.' },
    keyPoints: { type: 'array', items: { type: 'string' }, description: 'Ý chính đã thảo luận.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Quyết định đã chốt.' },
    actionItems: {
      type: 'array',
      description: 'Việc cần làm sau họp.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'task', 'due', 'dueDate'],
        properties: {
          owner: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Người nhận việc.' },
          task: { type: 'string' },
          due: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Hạn như được nói.' },
          dueDate: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'Hạn quy ra ngày YYYY-MM-DD theo ngày họp; null nếu không có hạn đủ rõ để chỉ ra một ngày.',
          },
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `Bạn tóm tắt biên bản cuộc họp từ transcript do máy nhận dạng giọng nói tạo ra.
- Viết bằng ngôn ngữ của transcript (thường là tiếng Việt), câu ngắn, rõ.
- Chỉ dựa vào transcript, không thêm thông tin bên ngoài. Transcript có thể sai chính tả vì nhận dạng tự động: sửa khi ngữ cảnh đã rõ, không chắc thì giữ nguyên.
- decisions chỉ gồm điều đã thực sự được chốt; ý kiến chưa thống nhất đưa vào keyPoints.
- actionItems: owner là tên người được giao nếu transcript nói rõ, ngược lại null; due là thời hạn đúng như được nói (vd "thứ sáu"), không có thì null.
- dueDate là hạn của due quy ra ngày YYYY-MM-DD, tính từ NGÀY HỌP được cho ở đầu yêu cầu (giờ Việt Nam). "Thứ sáu" là thứ sáu SẮP TỚI gần nhất, không phải ngày đã qua; "hôm nay" là chính ngày họp. Hạn mơ hồ ("sớm", "cuối quý", "khi nào xong") hoặc không có hạn thì dueDate là null — không đoán.
- Không có mục nào thì để mảng rỗng.`;

const VN_WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` → mili giây UTC nửa đêm; `undefined` nếu không phải ngày thật (30/2, 2026-13-01…). */
function dayMillis(date: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Date.UTC "cuốn" ngày vượt tháng (02-30 → 03-02) → so lại để từ chối.
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d
    ? ms
    : undefined;
}

/**
 * Dòng đầu của yêu cầu: ngày họp kèm THỨ — model quy "thứ sáu" ra ngày dễ sai nếu phải tự tính thứ
 * của một ngày ISO, nên đưa sẵn.
 */
export function describeMeetingDate(meetingDate: string): string {
  const ms = dayMillis(meetingDate);
  if (ms === undefined) return `Ngày họp: ${meetingDate} (giờ Việt Nam).`;
  return `Ngày họp: ${VN_WEEKDAYS[new Date(ms).getUTCDay()]}, ${meetingDate} (giờ Việt Nam).`;
}

/** Hạn cho phép: từ 1 ngày TRƯỚC ngày họp (nói "hôm qua đã gửi") đến 2 năm sau. */
const DUE_BEFORE_DAYS = 1;
const DUE_AFTER_DAYS = 730;

/**
 * Kiểm LẠI `dueDate` model trả (M12 Q2): sai dạng, không phải ngày thật, hoặc ngoài khoảng hợp lý quanh
 * ngày họp (model quy nhầm năm: "2024-…") → `null`, KHÔNG làm hỏng cả bản tóm tắt. Một hạn sai chỉ
 * mất một trường; `due` chữ gốc vẫn còn để người đọc.
 */
export function resolveDueDate(value: unknown, meetingDate: string): string | null {
  if (typeof value !== 'string') return null;
  const due = dayMillis(value);
  const base = dayMillis(meetingDate);
  if (due === undefined || base === undefined) return null;
  const days = (due - base) / MS_PER_DAY;
  return days >= -DUE_BEFORE_DAYS && days <= DUE_AFTER_DAYS ? value : null;
}

/** `[mm:ss] câu nói` từng dòng — mốc thời gian giúp model gom ý theo diễn biến cuộc họp. */
export function formatTranscript(segments: SummaryInput['segments']): string[] {
  return segments.map((s) => {
    const total = Math.floor(s.startMs / 1000);
    const hh = Math.floor(total / 3600);
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `[${hh > 0 ? `${hh}:` : ''}${mm}:${ss}] ${s.text}`;
  });
}

/** Gom dòng thành các phần ≤ `maxChars` (không cắt giữa một dòng). Dòng dài hơn tự thành một phần. */
export function chunkLines(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Kiểm LẠI ở server (plan M6): structured outputs bảo đảm đúng hình dạng khi model trả lời bình
 * thường, nhưng refusal / cắt `max_tokens` / API khác hành vi thì không. Sai → `null`.
 */
export function parseSummaryContent(
  raw: string,
  meetingDate: string,
): MeetingSummaryContent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.overview !== 'string' || v.overview.trim() === '') return null;
  if (!isStrings(v.keyPoints) || !isStrings(v.decisions)) return null;
  if (!isActionItems(v.actionItems)) return null;
  return {
    overview: v.overview,
    keyPoints: v.keyPoints,
    decisions: v.decisions,
    // `isActionItems` đã bảo đảm hình dạng; `dueDate` tách riêng vì model có thể trả sai mà phần còn
    // lại vẫn đúng (xem `resolveDueDate`), và tóm tắt cũ / model bỏ sót thì coi là không có hạn.
    actionItems: v.actionItems.map((item) => ({
      owner: item.owner,
      task: item.task,
      due: item.due,
      dueDate: resolveDueDate((item as { dueDate?: unknown }).dueDate, meetingDate),
    })),
  };
}

export const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const isNullableString = (v: unknown) => v === null || typeof v === 'string';

/** Dùng chung với báo cáo tuần (`report-format.ts`): cùng hình dạng việc cần làm. */
export function isActionItems(v: unknown): v is MeetingSummaryContent['actionItems'] {
  return (
    Array.isArray(v) &&
    v.every((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const i = item as Record<string, unknown>;
      return typeof i.task === 'string' && isNullableString(i.owner) && isNullableString(i.due);
    })
  );
}
