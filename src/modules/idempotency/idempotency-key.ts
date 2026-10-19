import { createHash } from 'node:crypto';
import { Errors } from '../../common/errors/errors.js';
import type { IdempotencyKeyRow } from '../../infra/database/schema/index.js';
import type { ExistingKeyDecision } from './idempotency.types.js';

/** Node hạ tên header về chữ thường. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Gắn vào response trả lại từ bản đã lưu — client / log phân biệt được "chạy thật" và "trả lại". */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Giữ response 24 giờ — bằng hạn của upload: quá hạn rồi thì gọi lại init cũng vô nghĩa. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/**
 * `processing` lâu hơn mức này = request đầu đã chết giữa chừng (crash, deploy) → request sau được
 * giữ chỗ lại. Phải DÀI HƠN thời gian chạy tối đa của route gắn `@Idempotent()`: ngắn quá thì một
 * request chậm nhưng còn sống bị chiếm chỗ → thao tác chạy hai lần.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 60;

/** ASCII in được (0x21–0x7E): không khoảng trắng, không ký tự điều khiển. Giới hạn 255 như Stripe. */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Không có header → `undefined` (route chạy bình thường). Có mà sai dạng → 400, không im lặng bỏ qua. */
export function parseIdempotencyKey(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
    throw Errors.idempotency.invalidKey();
  }
  return header;
}

/**
 * JSON với key của object SẮP XẾP: `{a,b}` và `{b,a}` là cùng một request. `JSON.stringify` giữ thứ
 * tự client gửi → cùng nội dung mà khác thứ tự field sẽ bị coi là "request khác" (422 oan).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Băm cả method + path, không chỉ body: cùng key dùng cho route khác (vd init ở tổ chức khác) cũng là
 * "dùng lại key cho request khác". Băm body THÔ (trước ValidationPipe): interceptor chạy trước pipe.
 */
export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

/** So nội dung TRƯỚC trạng thái: dùng sai key là lỗi của client dù request đầu đã xong hay chưa. */
export function decideExisting(
  existing: Pick<IdempotencyKeyRow, 'requestHash' | 'status' | 'responseStatus' | 'responseBody'>,
  hash: string,
): ExistingKeyDecision {
  if (existing.requestHash !== hash) return { kind: 'reused' };
  if (existing.status === 'processing') return { kind: 'in-progress' };
  if (existing.responseStatus === null) {
    // CHECK `idempotency_keys_completed_ck` chặn trạng thái này ở DB.
    throw new Error('idempotency_keys: completed mà không có response_status');
  }
  return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody };
}
