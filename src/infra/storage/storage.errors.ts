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
