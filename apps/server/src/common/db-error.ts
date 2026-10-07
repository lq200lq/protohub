/**
 * 唯一约束冲突的判定（Postgres 的 23505 被 Prisma 收敛成已知错误码 `P2002`）。
 *
 * 抢编码（机制 §3.0）与抢版本号（§3.1/§3.2）用的是同一个库信号，所以判定只留这一处：
 * 两处各写一遍 `code === 'P2002'`，将来其中一份漏掉某种错误形态（裸 SQL 与查询构造器的
 * 错误对象并不总是一致）就会表现成"该重试的没重试"（§3.7 通用能力收敛一处）。
 *
 * 按 `code` 判而不是 `instanceof Prisma.PrismaClientKnownRequestError`：后者要求错误对象
 * 由 Prisma 的构造函数产出，测试替身与换 driver 时同一个码仍然成立，判定却会失效。
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
