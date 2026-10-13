export class ErrorDetailDto {
  /**
   * Đường dẫn tới field lỗi (dạng chấm cho field lồng nhau).
   * @example "members.0.role"
   */
  field?: string;

  /** @example "role must be one of the following values: admin, member" */
  message: string;
}

export class ErrorBodyDto {
  /**
   * Mã lỗi máy đọc được — client rẽ nhánh theo mã này, không theo `message`.
   * @example "VALIDATION_FAILED"
   */
  code: string;

  /** Mô tả cho người đọc. Có thể thay đổi bất kỳ lúc nào. */
  message: string;

  /** Chi tiết từng field (chỉ có với lỗi validate). */
  details?: ErrorDetailDto[];

  /**
   * Trùng với header `x-request-id`, dùng để tra log.
   * @example "4f7d1c3e-2a9b-4c1d-8e6f-0a1b2c3d4e5f"
   */
  requestId?: string;
}

/** Định dạng chung của mọi response lỗi. */
export class ErrorResponseDto {
  error: ErrorBodyDto;
}
