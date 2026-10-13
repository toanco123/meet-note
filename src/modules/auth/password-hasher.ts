import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** Giới hạn dùng chung cho DTO. Trần 128 ký tự chặn DoS bằng mật khẩu cực dài (argon2 tốn CPU/RAM). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Tham số argon2id theo khuyến nghị tối thiểu của OWASP (Password Storage Cheat Sheet):
 * m = 19 MiB, t = 2, p = 1. Tăng tham số sau này thì hash cũ vẫn verify được (tham số nằm
 * trong chuỗi PHC), và `needsRehash` báo để băm lại lúc người dùng đăng nhập thành công.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  /** Không ném lỗi với hash hỏng định dạng (dữ liệu bẩn) — coi như sai mật khẩu. */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }

  /**
   * Gọi khi email KHÔNG tồn tại: vẫn tốn thời gian như một lần verify thật, để kẻ tấn công không
   * phân biệt "email không có" (trả ngay) với "sai mật khẩu" (chờ argon2) qua thời gian phản hồi.
   */
  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(await this.dummyHash, plain);
  }
}
