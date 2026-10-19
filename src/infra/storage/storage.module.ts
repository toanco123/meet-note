import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { S3ObjectStorage } from './s3-object-storage.js';

/** Token DI: module domain inject `ObjectStorage` qua token này, không phụ thuộc lớp S3. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
const S3_CLIENT = Symbol('S3_CLIENT');

@Injectable()
class StorageLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Storage');

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(OBJECT_STORAGE) private readonly storage: S3ObjectStorage,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('S3_CREATE_BUCKET', { infer: true })) return;
    await this.storage.ensureBucket();
    this.logger.log(`Bucket "${this.config.get('S3_BUCKET', { infer: true })}" sẵn sàng`);
  }

  /** Đóng socket keep-alive của SDK — không thì tiến trình dừng chậm / test treo. */
  onModuleDestroy(): void {
    this.client.destroy();
  }
}

/**
 * Lưu file trên S3 / RustFS (M5). Nằm trong `CoreModule`: api upload, worker (M6) đọc lại file.
 * `@Global()` như `DatabaseModule` / `RedisModule`: module domain inject `OBJECT_STORAGE` không cần import.
 */
@Global()
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        new S3Client({
          region: config.get('S3_REGION', { infer: true }),
          endpoint: config.get('S3_ENDPOINT', { infer: true }),
          forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
          // BẪY (M5 B4): mặc định `WHEN_SUPPORTED` → SDK bọc body vào stream tính CRC32 (aws-chunked).
          // Client ngắt giữa chừng → `req` lỗi → stream bọc của SDK phát lại CÙNG lỗi đó mà không ai
          // nghe → uncaught exception → CẢ TIẾN TRÌNH API CRASH. Không bọc thì không có stream mồ côi.
          // Đánh đổi: mỗi phần không có checksum riêng phía S3; toàn vẹn: TCP/TLS + sha256 toàn file
          // do worker kiểm ở M6.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          credentials: {
            accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
            secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
          },
        }),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [S3_CLIENT, ConfigService],
      useFactory: (client: S3Client, config: ConfigService<EnvironmentVariables, true>) =>
        new S3ObjectStorage(client, config.get('S3_BUCKET', { infer: true })),
    },
    StorageLifecycle,
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
