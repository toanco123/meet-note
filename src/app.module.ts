import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';

/** Root module của tiến trình api (HTTP + WebSocket). */
@Module({
  imports: [CoreModule, HealthModule, AuthModule],
})
export class AppModule {}
