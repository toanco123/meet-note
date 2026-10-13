import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InvitesModule } from './modules/invites/invites.module.js';
import { MeModule } from './modules/me/me.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';

/** Root module của tiến trình api (HTTP + WebSocket). */
@Module({
  imports: [
    CoreModule,
    AuditModule,
    HealthModule,
    AuthModule,
    MeModule,
    OrganizationsModule,
    InvitesModule,
  ],
})
export class AppModule {}
