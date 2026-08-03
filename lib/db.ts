/**
 * Prisma client 单例
 * ============================================================================
 * 按项目部署铁律，GCP + Neon 只是临时宿主，功能做完要整体迁到客户自有的
 * DigitalOcean 服务器，数据库也一并迁离 Neon 改为标准 PostgreSQL。
 *
 * 这里原本写死 `PrismaNeon` + `@neondatabase/serverless`（WebSocket 协议），
 * 连不上标准 PostgreSQL —— 这是私有化的第一道门。现在按 `DATABASE_DRIVER`
 * 分两个分支，选择逻辑见 `lib/db-driver.ts`。
 *
 *   neon —— ⚠️ **不要删**。回滚窗口内 Cloud Run 还在跑这个分支，
 *           且铁律明文「为 Neon 写的迁就现在不要提前去掉」。
 *   pg   —— 迁移后的目标形态。私有化下连接串走 unix socket，
 *           数据库可配 listen_addresses='' 完全不监听网络：
 *           postgresql://veggie@localhost/veggie?host=/var/run/postgresql
 */
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaPg } from '@prisma/adapter-pg'
import ws from 'ws'
import { PrismaClient } from './generated/prisma/client'
import { resolveDatabaseDriver } from './db-driver'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!

  // 没有连接串时，选哪个 adapter 都一样——任何查询都会失败。所以这里不判定、
  // 不抛错，保持改造前的行为（构造 neon adapter 但不连接），把错误留给首次查询。
  // 在模块加载阶段抛，会打死那些间接 import 到本文件却从不查库的测试
  // （lib/backup.ts、lib/analytics/* 都在这条传递路径上）。
  const driver = connectionString
    ? resolveDatabaseDriver(process.env.DATABASE_DRIVER, connectionString)
    : 'neon'

  if (driver === 'pg') {
    // PrismaPg 接受 pg.Pool | pg.PoolConfig | string，这里给 PoolConfig
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  }

  // WebSocket 构造器只在真的走 neon 时才装配
  neonConfig.webSocketConstructor = ws
  // PrismaNeon expects a PoolConfig (connection config), not a Pool instance
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString }) })
}

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
