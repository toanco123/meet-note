import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AppException } from '../../common/errors/app.exception.js';
import { Errors } from '../../common/errors/errors.js';
import { SessionsService } from '../auth/services/sessions.service.js';
import { TokenService } from '../auth/services/token.service.js';
import { isUuid } from '../../common/validation/uuid.js';
import { toConnectError, toRealtimeError } from './realtime-errors.js';
import { RealtimeSubscriptionsService } from './realtime-subscriptions.service.js';
import { REALTIME_REVALIDATE_EVENT } from '../../infra/realtime/redis-emitter.publisher.js';
import { RealtimeRoom } from '../../infra/realtime/realtime-rooms.js';
import type { AccessScope } from '../../infra/realtime/realtime.types.js';
import { REALTIME_NAMESPACE } from '../../infra/realtime/realtime.module.js';
import type {
  RealtimeAck,
  RemoteRealtimeSocket,
  RealtimeNamespace,
  RealtimeSocket,
  SocketUser,
} from './realtime.types.js';

/**
 * Socket.IO namespace `/realtime` (D6). Socket chỉ để NHẬN event; ghi vẫn qua REST.
 *
 * Xác thực ở **middleware của namespace** (chạy TRƯỚC khi kết nối được chấp nhận), không ở
 * `handleConnection`: từ chối trong `handleConnection` thì socket đã "connected" một nhịp, client
 * thấy `connect` rồi mới `disconnect`, và có thể đã kịp vào room. Middleware từ chối → client nhận
 * `connect_error` với `err.data.code` (M7 Q4).
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayInit<RealtimeNamespace>, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer() namespace!: RealtimeNamespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    private readonly subscriptions: RealtimeSubscriptionsService,
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
    namespace.on(REALTIME_REVALIDATE_EVENT, (scope) => {
      this.revalidate(scope).catch((error: unknown) =>
        this.logger.error({ err: error, scope }, 'Kiểm lại quyền subscription lỗi'),
      );
    });
  }

  async handleConnection(socket: RealtimeSocket): Promise<void> {
    const { user } = socket.data;
    await socket.join([RealtimeRoom.user(user.id), RealtimeRoom.session(user.sessionId)]);
    this.disconnectWhenTokenExpires(socket, user.tokenExpiresAt);
  }

  /**
   * Theo dõi một meeting: vào room `meeting:{id}` CHỈ khi xem được (điều kiện xem dùng chung của REST).
   * Trả qua ACK (M7 Q4): `{ data: { meetingId } }` hoặc `{ error: { code, … } }`. Không xem được →
   * `NOT_FOUND` như REST (không nói "có nhưng bạn không được xem").
   * Không ném lỗi ra ngoài handler: Nest sẽ phát event `exception` riêng, client không biết lỗi đó
   * thuộc yêu cầu nào.
   */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck<{ meetingId: string }>> {
    try {
      const meetingId = meetingIdOf(body);
      if (!(await this.subscriptions.canView(socket.data.user.id, meetingId))) {
        throw Errors.meeting.notFound();
      }
      await socket.join(RealtimeRoom.meeting(meetingId));
      // KIỂM LẦN HAI sau khi vào room: một thay đổi làm mất quyền có thể commit + phát "kiểm lại"
      // ĐÚNG lúc giữa lần kiểm đầu và `join` — lệnh kiểm lại chạy khi socket chưa ở trong room nên
      // bỏ sót. Kiểm sau join: thay đổi commit trước lần kiểm này → thấy ngay; commit sau → lệnh
      // kiểm lại (phát sau commit) thấy socket đã ở trong room. Không còn khe nào lọt.
      if (!(await this.subscriptions.canView(socket.data.user.id, meetingId))) {
        await socket.leave(RealtimeRoom.meeting(meetingId));
        throw Errors.meeting.notFound();
      }
      return { data: { meetingId } };
    } catch (error) {
      return { error: toRealtimeError(error) };
    }
  }

  /** Rời room; chưa từng vào → vẫn ok (idempotent). */
  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck<{ meetingId: string }>> {
    try {
      const meetingId = meetingIdOf(body);
      await socket.leave(RealtimeRoom.meeting(meetingId));
      return { data: { meetingId } };
    } catch (error) {
      return { error: toRealtimeError(error) };
    }
  }

  /**
   * Kiểm lại quyền của socket CỦA INSTANCE NÀY (`.local`) trong phạm vi bị ảnh hưởng (M7 Q2). Socket
   * không còn xem được → rời room + nhận `meeting.access_revoked`. Mọi instance cùng nhận lệnh
   * (`serverSideEmit`), mỗi instance chỉ lo socket của mình.
   */
  private async revalidate(scope: AccessScope): Promise<void> {
    if (scope.kind === 'user') {
      const sockets = await this.namespace.in(RealtimeRoom.user(scope.userId)).local.fetchSockets();
      for (const socket of sockets) {
        for (const room of socket.rooms) {
          const meetingId = RealtimeRoom.meetingIdOf(room);
          if (meetingId) await this.recheck(socket, meetingId);
        }
      }
      return;
    }
    const meetingIds =
      scope.kind === 'meeting'
        ? [scope.meetingId]
        : await this.subscriptions.meetingsInScope(scope, this.locallySubscribedMeetings());
    for (const meetingId of meetingIds) {
      const sockets = await this.namespace.in(RealtimeRoom.meeting(meetingId)).local.fetchSockets();
      for (const socket of sockets) await this.recheck(socket, meetingId);
    }
  }

  private async recheck(socket: RemoteRealtimeSocket, meetingId: string): Promise<void> {
    if (await this.subscriptions.canView(socket.data.user.id, meetingId)) return;
    socket.leave(RealtimeRoom.meeting(meetingId));
    socket.emit('meeting.access_revoked', { meetingId });
  }

  /** Meeting đang có ít nhất một subscriber Ở INSTANCE NÀY (adapter giữ danh sách room cục bộ). */
  private locallySubscribedMeetings(): string[] {
    return [...this.namespace.adapter.rooms.keys()]
      .map((room) => RealtimeRoom.meetingIdOf(room))
      .filter((id): id is string => id !== undefined);
  }

  /**
   * Kết nối sống lâu hơn access token (15 phút). Không tự ngắt → token hết hạn (vd user bị thu hồi
   * quyền, đổi mật khẩu…) mà socket vẫn nhận event mãi. Ngắt đúng `exp`; client kết nối lại bằng
   * token mới (đã refresh qua REST). Huỷ hẹn giờ khi socket tự ngắt trước, không giữ timer rác.
   */
  private disconnectWhenTokenExpires(socket: RealtimeSocket, expiresAt: Date): void {
    const timer = setTimeout(
      () => {
        socket.emit('session.ended', { reason: 'token_expired' });
        socket.disconnect(true);
      },
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    socket.once('disconnect', () => clearTimeout(timer));
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
    return { id: sub, sessionId: sid, tokenExpiresAt: verified.expiresAt };
  }
}

/** Payload socket không đi qua ValidationPipe của REST → kiểm tay, lỗi cùng mã `VALIDATION_FAILED`. */
function meetingIdOf(body: unknown): string {
  const meetingId = (body as { meetingId?: unknown } | null)?.meetingId;
  if (!isUuid(meetingId)) {
    throw Errors.common.validationFailed([
      { field: 'meetingId', message: 'meetingId phải là uuid' },
    ]);
  }
  return meetingId;
}
