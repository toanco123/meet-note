import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { UsersModule } from '../users/users.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

/**
 * API của người đang đăng nhập. Tách khỏi UsersModule để phụ thuộc đi MỘT chiều:
 * users (dữ liệu) ← auth (danh tính, phiên) ← me (API); organizations ← me. Đặt /me trong UsersModule sẽ tạo
 * vòng UsersModule ↔ AuthModule (auth cần UsersRepository, /me/sessions cần SessionsService).
 */
@Module({
  imports: [UsersModule, AuthModule, OrganizationsModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
