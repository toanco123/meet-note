import { defineConfig } from 'vitest/config';

/**
 * Unit test: hàm thuần + Nest TestingModule với provider giả. Không I/O, không Docker.
 * Vite 8 (Oxc) đọc `experimentalDecorators` + `emitDecoratorMetadata` từ tsconfig → DI chạy
 * được mà không cần unplugin-swc.
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.spec.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test' },
    // main.ts import 'reflect-metadata' đầu tiên; test không đi qua main.ts nên nạp ở đây.
    // Thiếu dòng này → "Reflect.getMetadata is not a function" ở file không import @nestjs/*.
    setupFiles: ['reflect-metadata'],
  },
});
