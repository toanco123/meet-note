import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { AppThrottlerGuard } from '../../infra/rate-limit/app-throttler.guard.js';
import { RateLimitModule } from '../../infra/rate-limit/rate-limit.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './services/auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { jwtModuleOptions } from './jwt-options.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './services/sessions.service.js';
import { TokenService } from './services/token.service.js';

@Module({
  imports: [
    UsersModule,
    RateLimitModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        jwtModuleOptions(config.get('JWT_ACCESS_SECRET', { infer: true })),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordHasher,
    TokenService,
    SessionsRepository,
    SessionsService,
    // Guard toàn cục: áp cho MỌI controller của app, kể cả module khác. Route mở thì dùng @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // SAU JwtAuthGuard (cùng mảng → thứ tự chắc chắn): cần `req.user` để khoá theo người dùng.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
  exports: [PasswordHasher, TokenService, SessionsService],
})
export class AuthModule {}
