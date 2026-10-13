import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, Matches, Max, Min, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Toàn bộ biến môi trường mà ứng dụng đọc. Đây là nơi DUY NHẤT được đọc `process.env`;
 * phần còn lại của code dùng `ConfigService<EnvironmentVariables, true>`.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevel = 'info';

  // Không dùng @Type(() => Boolean): Boolean('false') === true.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() === 'true' : value,
  )
  @IsBoolean()
  LOG_PRETTY = false;

  @Matches(/^postgres(ql)?:\/\//, { message: 'DATABASE_URL phải bắt đầu bằng postgres://' })
  DATABASE_URL: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_POOL_MAX = 10;

  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL phải bắt đầu bằng redis:// hoặc rediss://' })
  REDIS_URL: string;
}

/** Dùng cho `ConfigModule.forRoot({ validate })`. Ném lỗi → tiến trình dừng ngay khi khởi động. */
export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, { exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });

  if (errors.length > 0) {
    const lines = errors.map(
      (e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
    );
    throw new Error(`Biến môi trường không hợp lệ:\n${lines.join('\n')}`);
  }
  return env;
}

export function isSwaggerEnabled(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== NodeEnv.Production;
}
