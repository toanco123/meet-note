import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { MultipartUploadNotFoundError } from './storage.errors.js';
import type { CompletedPart, ObjectStorage, UploadPartInput } from './storage.types.js';

/** Adapter `ObjectStorage` cho mọi server tương thích S3 (AWS, RustFS). */
export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!out.UploadId) throw new Error('S3 CreateMultipartUpload không trả UploadId');
    return { uploadId: out.UploadId };
  }

  async uploadPart(input: UploadPartInput): Promise<{ etag: string }> {
    const out = await this.client
      .send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          Body: input.body,
          ContentLength: input.contentLength,
        }),
        { abortSignal: input.signal },
      )
      .catch(rethrowMultipartNotFound);
    if (!out.ETag) throw new Error('S3 UploadPart không trả ETag');
    return { etag: out.ETag };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client
      .send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
        { abortSignal: signal },
      )
      .catch(rethrowMultipartNotFound);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      // Đã huỷ rồi / không còn → mục tiêu "không còn multipart" đã đạt. Gọi lại an toàn.
      if (isS3Error(error, 'NoSuchUpload', 404)) return;
      throw error;
    }
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | undefined> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0 };
    } catch (error) {
      if (isS3Error(error, 'NotFound', 404)) return undefined;
      throw error;
    }
  }

  /** Dev / test (`S3_CREATE_BUCKET=true`): tạo bucket nếu chưa có. Gọi lại an toàn. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isS3Error(error, 'NotFound', 404)) throw error;
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (createError) {
        // Hai tiến trình (api + worker) cùng tạo → bên đến sau nhận lỗi này, không sao.
        if (!isS3Error(createError, 'BucketAlreadyOwnedByYou', 409)) throw createError;
      }
    }
  }
}

/** HEAD không có body nên lỗi chỉ còn mã HTTP; lệnh khác có `name` theo mã lỗi S3. */
function isS3Error(error: unknown, name: string, httpStatus: number): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === name || error.$metadata.httpStatusCode === httpStatus)
  );
}

/** `NoSuchUpload` của S3 → lỗi của tầng storage (domain không cần biết tên lỗi SDK). */
function rethrowMultipartNotFound(error: unknown): never {
  // So đúng TÊN, không so mã 404: `NoSuchBucket` cũng là 404 nhưng là lỗi cấu hình, không được
  // biến thành "upload không còn". UploadPart / Complete có body lỗi nên luôn có `name`.
  if (error instanceof S3ServiceException && error.name === 'NoSuchUpload') {
    throw new MultipartUploadNotFoundError({ cause: error });
  }
  throw error;
}
