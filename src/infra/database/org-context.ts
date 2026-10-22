import { AsyncLocalStorage } from 'node:async_hooks';

/** Ngữ cảnh tổ chức của một request / một tác vụ — `null` = chưa xác định (RLS: không thấy dòng nào). */
interface OrgContextStore {
  orgId: string | null;
}

const storage = new AsyncLocalStorage<OrgContextStore>();

/**
 * Tổ chức mà request đang làm việc trong đó (M11 B7) — nguồn của `app.org_id` mà policy RLS đọc.
 *
 * - Middleware HTTP mở một ngữ cảnh RỖNG cho mỗi request (`run`); `OrgMemberGuard` điền `orgId`
 *   sau khi xác nhận người gọi là thành viên (`enter`).
 * - Chỗ không qua route `/orgs/:orgId` mà cần đọc bảng có RLS (realtime `subscribe`, …) bọc tường
 *   minh bằng `runInOrg(orgId, fn)`.
 * - Pool đọc `current()` MỖI lần cho mượn connection và đặt `app.org_id` (rỗng nếu không có) —
 *   connection trả về pool không mang ngữ cảnh của request trước sang request sau.
 */
export const OrgContext = {
  run<T>(fn: () => T): T {
    return storage.run({ orgId: null }, fn);
  },

  runInOrg<T>(orgId: string, fn: () => T): T {
    return storage.run({ orgId }, fn);
  },

  /** Điền tổ chức vào ngữ cảnh ĐANG mở (guard). Không có ngữ cảnh = lỗi cấu hình → ném. */
  enter(orgId: string): void {
    const store = storage.getStore();
    if (!store)
      throw new Error('OrgContext.enter() ngoài ngữ cảnh — thiếu middleware OrgContext.run');
    store.orgId = orgId;
  },

  current(): string | null {
    return storage.getStore()?.orgId ?? null;
  },
};
