import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { jwtModuleOptions } from './jwt-options.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        jwtModuleOptions(config.get('JWT_ACCESS_SECRET', { infer: true })),
    }),
  ],
  providers: [PasswordHasher, TokenService, SessionsRepository, SessionsService],
  exports: [PasswordHasher, TokenService, SessionsService],
})
export class AuthModule {}
