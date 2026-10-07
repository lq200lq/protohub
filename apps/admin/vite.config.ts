import { defineConfig } from '@vben/vite-config';

export default defineConfig(async () => {
  return {
    application: {},
    vite: {
      optimizeDeps: {
        // @protohub/shared 出的是 CJS dist（DEV-4：Nest/tsc 不能 import .ts）。
        // 直连 /@fs 时 Vite 不预构建，`import { isPermissionCode }` 会报
        // "does not provide an export named"，路由守卫直接卡死在"加载菜单中"。
        // 显式列入预构建，让 esbuild 把 CJS 具名导出转成 ESM。
        include: ['@protohub/shared'],
      },
      server: {
        // 端口冲突要立刻失败，不要静默顺延到别的端口（会把验收指向别人的服务）
        strictPort: true,
        proxy: {
          '/api': {
            changeOrigin: true,
            // ProtoHub 后端（apps/server）带全局 /api 前缀，因此不做 path 重写
            target: 'http://127.0.0.1:3100',
            ws: true,
          },
        },
      },
    },
  };
});
