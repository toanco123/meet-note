/** Một request mang header `Idempotency-Key`, đã chuẩn hoá để so khớp với lần đầu. */
export interface IdempotentRequest {
  userId: string;
  key: string;
  method: string;
  /** `req.originalUrl` (gồm cả query string). */
  path: string;
  /** sha256 (hex) của method + path + body dạng JSON chuẩn hoá. */
  requestHash: string;
}

/**
 * Key đã có người giữ thì làm gì:
 * - `replay`: request đầu đã xong, cùng nội dung → trả lại đúng response đã lưu;
 * - `reused`: nội dung khác lần đầu → 422;
 * - `in-progress`: request đầu chưa xong → 409.
 */
export type ExistingKeyDecision =
  { kind: 'replay'; status: number; body: unknown } | { kind: 'reused' } | { kind: 'in-progress' };

/** Kết quả giữ chỗ: mình được chạy handler (kèm fencing token), hoặc trả lại response đã lưu. */
export type IdempotencyClaim =
  { kind: 'claimed'; claimedAt: string } | Extract<ExistingKeyDecision, { kind: 'replay' }>;
