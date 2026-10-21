import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { AccessScope, RealtimePublisher, SessionEndedReason } from './realtime.types.js';

/** Event giữa các SERVER (không tới client) — gateway của mỗi api instance nghe. */
export const REALTIME_REVALIDATE_EVENT = 'realtime.revalidate';

/**
 * `@socket.io/redis-emitter`: PUBLISH lệnh vào kênh Redis mà Redis adapter của mọi api instance
 * đang nghe → chạy được cả trong worker (không có server Socket.IO). Dùng chung cho api: một
 * đường duy nhất, không phải nhớ "ở api thì gọi server, ở worker thì gọi emitter".
 */
export class RedisEmitterPublisher implements RealtimePublisher {
  private readonly emitter;

  constructor(redis: Redis, key: string, namespace: string) {
    this.emitter = new Emitter(redis, { key }).of(namespace);
  }

  emit(rooms: string[], event: string, payload: unknown): void {
    if (rooms.length === 0) return;
    this.emitter.to(rooms).emit(event, payload);
  }

  endSessions(rooms: string[], reason: SessionEndedReason): void {
    if (rooms.length === 0) return;
    // Hai lệnh PUBLISH trên CÙNG một kết nối Redis → mỗi instance nhận đúng thứ tự: event trước,
    // ngắt sau — client kịp biết lý do để refresh token / về màn đăng nhập.
    this.emitter.to(rooms).emit('session.ended', { reason });
    this.emitter.in(rooms).disconnectSockets(true);
  }

  /**
   * `serverSideEmit`: tới gateway của MỌI api instance (không tới client). Mỗi instance tự kiểm socket
   * CỦA MÌNH — chỉ instance giữ socket mới biết socket đó đang ở room nào.
   */
  revalidateAccess(scope: AccessScope): void {
    this.emitter.serverSideEmit(REALTIME_REVALIDATE_EVENT, scope);
  }
}
