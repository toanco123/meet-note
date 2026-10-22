/**
 * Lỗi của tầng storage, KHÔNG lộ tên lỗi của SDK (`NoSuchUpload`…) ra module domain: đổi sang
 * server / SDK khác thì chỉ sửa adapter.
 */

/** Multipart không còn (đã complete / đã abort / sai id). */
export class MultipartUploadNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('Multipart upload không còn tồn tại', options);
    this.name = 'MultipartUploadNotFoundError';
  }
}

/** Object không có (key sai / đã xoá). */
export class ObjectNotFoundError extends Error {
  constructor(
    readonly key: string,
    options?: ErrorOptions,
  ) {
    super(`Object không tồn tại: ${key}`, options);
    this.name = 'ObjectNotFoundError';
  }
}
