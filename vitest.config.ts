import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置。
 *
 * 唯一的目的：让测试能解析 `src/` 内部使用的 `@/` 别名。
 *
 * 为什么需要：`src/` 里的模块之间用 `@/core/...` 互相引用（WXT/Vite 提供了这个别名），
 * 但 Vitest 不读 `wxt.config.ts`，所以默认解析不到 —— 表现是一进入某个用了别名的
 * 模块就报 "Failed to resolve import"。测试文件本身用相对路径引用源码，不受影响。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // 纯逻辑测试，不需要浏览器环境
    environment: 'node',
  },
});
