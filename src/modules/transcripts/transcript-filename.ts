import { SUBTITLE_FORMATS, type SubtitleFormat } from './transcript-formats.js';

const MAX_NAME_LENGTH = 80;

/**
 * Tên file an toàn từ TIÊU ĐỀ MEETING — do người dùng nhập, nên là dữ liệu không tin cậy đi thẳng vào
 * HEADER. Bỏ: ký tự điều khiển (CR / LF = chèn header khác), `" \ /` và các ký tự mà hệ điều hành cấm
 * trong tên file, gộp khoảng trắng, cắt độ dài (theo ký tự Unicode, không cắt giữa cặp thay thế).
 * Rỗng sau khi làm sạch → `meeting-<id>`.
 */
export function safeFileBase(title: string, meetingId: string): string {
  const cleaned = [
    ...title
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, ''); // không để tên chỉ toàn dấu chấm ("..") hoặc kết thúc bằng chấm
  return cleaned || `meeting-${meetingId}`;
}

/** RFC 5987: `encodeURIComponent` còn để nguyên `' ( ) *` — phải tự mã hoá. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<mã hoá>`. Bản ASCII cho
 * client cũ (bỏ dấu, `đ` → `d`, ký tự lạ → `_`); bản `filename*` giữ nguyên tiếng Việt.
 */
export function contentDisposition(
  title: string,
  meetingId: string,
  format: SubtitleFormat,
): string {
  if (!SUBTITLE_FORMATS.includes(format)) throw new Error(`Định dạng lạ: ${format}`);
  const base = safeFileBase(title, meetingId);
  const ascii = base
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._ -]/g, '_');
  return `attachment; filename="${ascii}.${format}"; filename*=UTF-8''${encodeRfc5987(`${base}.${format}`)}`;
}
