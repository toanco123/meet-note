import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { EnvironmentVariables } from '../../config/env.validation.js';

/**
 * Socket.IO + Redis adapter (D6, M7 Q3): mọi api instance cùng nghe một kênh Redis → `emit` /
 * `disconnectSockets` / `fetchSockets` vào một room chạy đúng dù socket nằm ở instance khác, và
 * redis-emitter (worker) phát được tới client.
 *
 * Hai kết nối RIÊNG (pub / sub), không dùng `REDIS` chung: kết nối đã SUBSCRIBE thì không chạy
 * lệnh thường được nữa. `lazyConnect`: chỉ kết nối khi gateway thật sự khởi tạo — script export
 * OpenAPI tạo app mà không init gateway thì không đụng tới Redis.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const config = this.app.get(ConfigService<EnvironmentVariables, true>);
    const url = config.get('REDIS_URL', { infer: true });
    const pub = new Redis(url, { lazyConnect: true });
    const sub = new Redis(url, { lazyConnect: true });
    for (const client of [pub, sub]) {
      client.on('error', () => undefined); // lỗi kết nối đã được adapter / health check phản ánh
      this.clients.push(client);
    }
    const allowed = config.get('REALTIME_CORS_ORIGINS', { infer: true });
    const server = super.createIOServer(port, {
      ...options,
      // `cors` chỉ áp cho HTTP long-polling; trình duyệt KHÔNG áp CORS cho WebSocket → tự kiểm
      // `Origin` ở `allowRequest` (chạy cho handshake của MỌI transport). Không có `Origin` = client
      // không phải trình duyệt (mobile, server, test) → cho qua; xác thực vẫn ở middleware token.
      cors: { origin: allowed, credentials: false },
      allowRequest: (req, callback) => {
        const { origin } = req.headers;
        callback(null, origin === undefined || allowed.includes(origin));
      },
    } as ServerOptions) as Server;
    server.adapter(
      createAdapter(pub, sub, { key: config.get('REALTIME_REDIS_KEY', { infer: true }) }),
    );
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all(this.clients.map((c) => c.quit().catch(() => c.disconnect())));
  }
}
