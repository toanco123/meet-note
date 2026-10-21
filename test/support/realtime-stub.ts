import { REALTIME_PUBLISHER } from '../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../src/infra/realtime/realtime.types.js';

/**
 * Provider giả cho test dựng service bằng TestingModule mà không cần Socket.IO: service gọi
 * `revalidateAccess` / `endSessions` sau commit — ở đây không làm gì.
 */
export const realtimeStub = {
  provide: REALTIME_PUBLISHER,
  useValue: {
    emit: () => undefined,
    endSessions: () => undefined,
    revalidateAccess: () => undefined,
  } satisfies RealtimePublisher,
};
