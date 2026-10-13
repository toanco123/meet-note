import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { MeModule } from './modules/me/me.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';

/** Root module của tiến trình api (HTTP + WebSocket). */
@Module({
  imports: [CoreModule, HealthModule, AuthModule, MeModule, OrganizationsModule],
})
export class AppModule {}
