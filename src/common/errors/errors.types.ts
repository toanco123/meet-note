/** Kiểu của tầng lỗi: chi tiết lỗi, lỗi Postgres, kết quả map của filter. */

export interface ErrorDetail {
  /** Đường dẫn tới field lỗi, vd `members.0.role`. */
  field?: string;
  message: string;
}

export interface PgLikeError {
  code: string;
  /** Tên constraint/index bị vi phạm — dùng để map sang mã lỗi nghiệp vụ cụ thể. */
  constraint?: string;
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: ErrorDetail[];
}

/** Kênh mà một người đang làm chủ — liệt kê trong lỗi `ORG_MEMBER_OWNS_CHANNELS`. */
export interface OwnedChannel {
  id: string;
  name: string;
}
