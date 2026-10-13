export class HealthLiveResponseDto {
  /** Luôn là `ok` nếu tiến trình trả lời được. */
  status: 'ok';
}

export class DependencyChecksDto {
  /** Kết quả `SELECT 1` tới Postgres. */
  database: 'up' | 'down';

  /** Kết quả `PING` tới Redis. */
  redis: 'up' | 'down';
}

export class HealthReadyResponseDto {
  /** `ok` khi mọi phụ thuộc đều `up`; ngược lại `error` và HTTP 503. */
  status: 'ok' | 'error';

  checks: DependencyChecksDto;
}
