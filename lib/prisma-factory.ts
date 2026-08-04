/**
 * PrismaClient 工厂 —— 唯一构造入口
 * ============================================================================
 * 为什么有这一层：迁到客户自有服务器后连的是标准 PostgreSQL。`lib/db.ts` 改成
 * 双驱动之后，**scripts/ 与 prisma/ 下还有 63 个文件各自 `new PrismaClient({
 * adapter: new PrismaNeon(...) })`**，绕过 lib/db 直连 Neon 的 WebSocket 协议
 * （2026-08-03 发现，设计文档最初的耦合点清查漏了这一整片）。
 *
 * 这不是理论问题：`prisma/seed.ts` 写死 Neon，连不上容器里的标准 PostgreSQL，
 * 迁移演练第一步建完表就没法灌种子数据。
 *
 * 所以构造 PrismaClient 只走这一个函数。驱动选择逻辑在 `lib/db-driver.ts`。
 *
 * - Next 运行时：`lib/db.ts` 用它建单例，业务代码继续 `import { prisma }`
 * - 脚本/种子：`const prisma = createPrismaClient()`
 */
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaPg } from '@prisma/adapter-pg'
import ws from 'ws'
import { PrismaClient } from './generated/prisma/client'
import { resolveDatabaseDriver } from './db-driver'

/**
 * 按 `DATABASE_DRIVER` / 连接串建一个 PrismaClient。
 *
 * 没有连接串时不判定、不抛错，回落到 neon（保持改造前行为）：选哪个 adapter 都
 * 一样会在首次查询失败，而在模块加载阶段抛会打死那些间接 import 到本文件却从不
 * 查库的测试。
 */
export function createPrismaClient(
  connectionString: string | undefined = process.env.DATABASE_URL,
): PrismaClient {
  const driver = connectionString
    ? resolveDatabaseDriver(process.env.DATABASE_DRIVER, connectionString)
    : 'neon'

  if (driver === 'pg') {
    // PrismaPg 接受 pg.Pool | pg.PoolConfig | string，这里给 PoolConfig
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) })
  }

  // WebSocket 构造器只在真的走 neon 时才装配
  neonConfig.webSocketConstructor = ws
  // PrismaNeon expects a PoolConfig (connection config), not a Pool instance
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString: connectionString! }) })
}
