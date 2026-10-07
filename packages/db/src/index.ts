/**
 * @protohub/db —— PrismaClient 导出入口（M0-T4）。
 *
 * 供 Nest 服务端注入使用：
 *   - `getPrismaClient()`：进程级单例（默认读环境变量 DATABASE_URL）。
 *   - `createPrismaClient(url?)`：独立实例（测试/多库场景，传入 URL 时覆盖 datasource）。
 *   - `prisma`：单例的便捷别名。
 *
 * 注意：本项目连接串一律使用 127.0.0.1，禁止主机名 localhost（项目约定，见部署与运维方案）。
 */
import { Prisma, PrismaClient } from '@prisma/client';

// 重新导出全部生成的模型类型（PrismaClient / Prisma / 各 model、枚举联合等），
// 让消费方只需 `import { prisma, SysUser } from '@protohub/db'`。
export * from '@prisma/client';
export { PrismaClient };

/** 独立的 PrismaClient 工厂：url 为空时回落 process.env.DATABASE_URL。 */
export function createPrismaClient(
  url?: string,
  options?: Prisma.PrismaClientOptions,
): PrismaClient {
  const datasourceUrl = url ?? process.env.DATABASE_URL;
  const resolved: Prisma.PrismaClientOptions = datasourceUrl
    ? {
        ...options,
        datasources: {
          db: { url: datasourceUrl },
          ...(options?.datasources ?? {}),
        },
      }
    : { ...options };
  return new PrismaClient(resolved);
}

let sharedClient: PrismaClient | undefined;

/** 进程级共享单例（Nest 的 PrismaModule 应注入此实例）。 */
export function getPrismaClient(): PrismaClient {
  sharedClient ??= createPrismaClient();
  return sharedClient;
}

/** 单例的便捷别名（首次访问即创建；连接在首个查询时才建立）。 */
export const prisma: PrismaClient = getPrismaClient();

/** 关闭单例连接（进程退出 / 测试收尾时调用）。 */
export async function disconnectPrisma(): Promise<void> {
  if (sharedClient) {
    const client = sharedClient;
    sharedClient = undefined;
    await client.$disconnect();
  }
}
