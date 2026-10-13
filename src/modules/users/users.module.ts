import { Module } from '@nestjs/common';
import { UsersRepository } from './users.repository.js';

/** Dữ liệu người dùng. Controller `/me` được thêm ở M1 B9. */
@Module({
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
