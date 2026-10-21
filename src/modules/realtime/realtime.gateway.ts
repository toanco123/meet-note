import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AppException } from '../../common/errors/app.exception.js';
import { Errors } from '../../common/errors/errors.js';
import { SessionsService } from '../auth/services/sessions.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { toConnectError } from './realtime-errors.js';
import { RealtimeRoom } from './realtime-rooms.js';
import type { RealtimeNamespace, RealtimeSocket, SocketUser } from './realtime.types.js';

/**
 * Socket.IO namespace `/realtime` (D6). Socket chỉ để NHẬN event; ghi vẫn qua REST.
 *
 * Xác thực ở **middleware của namespace** (chạy TRƯỚC khi kết nối được chấp nhận), không ở
 * `handleConnection`: từ chối trong `handleConnection` thì socket đã "connected" một nhịp, client
 * thấy `connect` rồi mới `disconnect`, và có thể đã kịp vào room. Middleware từ chối → client nhận
 * `connect_error` với `err.data.code` (M7 Q4).
 */
@WebSocketGateway({ namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayInit<RealtimeNamespace>, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer() namespace!: RealtimeNamespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  afterInit(namespace: RealtimeNamespace): void {
    namespace.use((socket, next) => {
      this.authenticate(socket).then(
        (user) => {
          socket.data.user = user;
          next();
        },
        (error: unknown) => {
          if (!(error instanceof AppException)) this.logger.error({ err: error }, 'Handshake lỗi');
          next(toConnectError(error));
        },
      );
    });
  }

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    const { user } = socket.data;
    await socket.join([RealtimeRoom.user(user.id), RealtimeRoom.session(user.sessionId)]);
  }

  /**
   * Cùng HAI lớp với `JwtAuthGuard` của REST: chữ ký + hạn của JWT, rồi phiên còn sống (1 query) —
   * logout / thu hồi phiên có hiệu lực ngay cả với kết nối mới. Token gửi trong `auth` của handshake
   * (`io(url, { auth: { token } })`), KHÔNG trong query string: query string nằm trong log của proxy.
   */
  private async authenticate(socket: RealtimeSocket): Promise<SocketUser> {
    const token: unknown = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token !== 'string' || token.length === 0) throw Errors.auth.tokenMissing();

    const verified = await this.tokens.verifyAccessToken(token);
    if (!verified.ok) {
      throw verified.reason === 'expired' ? Errors.auth.tokenExpired() : Errors.auth.tokenInvalid();
    }
    const { sub, sid } = verified.claims;
    if (!(await this.sessions.isActive(sid, sub))) throw Errors.auth.sessionRevoked();
    return { id: sub, sessionId: sid };
  }
}
