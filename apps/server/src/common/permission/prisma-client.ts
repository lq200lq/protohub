import type { PrismaClient } from "@protohub/db";

/**
 * 数据库客户端的注入令牌（唯一来源）。
 *
 * 走 DI 而不是到处 `import { prisma }`：集成测试需要一个指向 protohub_test 的实例，
 * 覆盖 provider 比操纵环境变量可靠。provider 在 modules/system/persistence/SystemDataModule（@Global）。
 */
export const PRISMA_CLIENT = "protohub:prisma-client";

export type PrismaClientToken = typeof PRISMA_CLIENT;
export type { PrismaClient };
