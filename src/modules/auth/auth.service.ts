import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import { isUniqueViolation } from '../../common/errors/pg-error.js';
import { USERS_EMAIL_UNIQUE, UsersRepository } from '../users/users.repository.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { PasswordHasher } from './password-hasher.js';
import type { SessionMeta } from './sessions.repository.js';
import { type AuthTokens, SessionsService } from './sessions.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionsService,
  ) {}

  async register(dto: RegisterDto, meta: SessionMeta): Promise<AuthTokens> {
    const passwordHash = await this.hasher.hash(dto.password);

    // Không "SELECT trước rồi INSERT": hai request đăng ký cùng email chạy song song sẽ cùng thấy
    // "chưa có". Để unique index quyết định, rồi dịch lỗi 23505 thành mã nghiệp vụ.
    const user = await this.users
      .insert({ email: dto.email, passwordHash, displayName: dto.displayName })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, USERS_EMAIL_UNIQUE)) {
          throw AppException.conflict(ErrorCode.AuthEmailTaken, 'Email này đã được sử dụng.');
        }
        throw error;
      });

    return this.sessions.create(user.id, meta);
  }

  async login(dto: LoginDto, meta: SessionMeta): Promise<AuthTokens> {
    const user = await this.users.findByEmail(dto.email);

    if (!user) {
      // Vẫn chạy argon2 để thời gian phản hồi giống "sai mật khẩu" → không dò được email nào tồn tại.
      await this.hasher.verifyDummy(dto.password);
      throw invalidCredentials();
    }

    if (!(await this.hasher.verify(user.passwordHash, dto.password))) {
      throw invalidCredentials();
    }

    // Chỉ lúc này ta có mật khẩu gốc trong tay → cơ hội duy nhất để nâng tham số băm.
    if (this.hasher.needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(user.id, await this.hasher.hash(dto.password));
    }

    return this.sessions.create(user.id, meta);
  }
}

/** Cùng mã + cùng thông điệp cho "không có email" và "sai mật khẩu". */
function invalidCredentials(): AppException {
  return new AppException(
    ErrorCode.AuthInvalidCredentials,
    HttpStatus.UNAUTHORIZED,
    'Email hoặc mật khẩu không đúng.',
  );
}
