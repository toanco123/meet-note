// Schema Drizzle của toàn bộ ứng dụng. Mỗi domain một file, re-export tại đây.
// drizzle-kit đọc file này để sinh migration (`pnpm db:generate`).
// Lưu ý: chỉ export bảng + kiểu; helper (column-types.ts) import trực tiếp khi cần.
export * from './users.js';
export * from './sessions.js';
export * from './organizations.js';
export * from './invites.js';
export * from './audit.js';
export * from './channels.js';
export * from './meetings.js';
export * from './transcripts.js';
export * from './uploads.js';
export * from './idempotency.js';
export * from './notifications.js';
export * from './reports.js';
export * from './action-items.js';
