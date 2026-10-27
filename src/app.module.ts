import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { AuditLogsModule } from './modules/audit/audit-logs.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ChannelsModule } from './modules/channels/channels.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InvitesModule } from './modules/invites/invites.module.js';
import { MeModule } from './modules/me/me.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { MeetingsModule } from './modules/meetings/meetings.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { TranscriptsModule } from './modules/transcripts/transcripts.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';

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
    ChannelsModule,
    UploadsModule,
    MeetingsModule,
    TranscriptsModule,
    ReportsModule,
    AuditLogsModule,
    RealtimeModule,
    NotificationsModule,
  ],
})
export class AppModule {}
