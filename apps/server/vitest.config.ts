import { defineConfig } from 'vitest/config';

/**
 * 服务端单测：node 环境、只跑 src 里同目录的 *.spec.ts。
 * 根 vitest.config.ts 是给 Vue 前端用的（happy-dom + vue 插件），不要复用。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    clearMocks: true,
  },
});
