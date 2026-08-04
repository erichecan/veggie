/**
 * Prisma client 单例（Next 运行时）
 * ============================================================================
 * 按项目部署铁律，GCP + Neon 只是临时宿主，功能做完要整体迁到客户自有的
 * DigitalOcean 服务器，数据库也一并迁离 Neon 改为标准 PostgreSQL。
 *
 * 构造逻辑在 `lib/prisma-factory.ts`（唯一构造入口，scripts 与种子也用它），
 * 驱动选择逻辑在 `lib/db-driver.ts`。这里只负责单例。
 */
import { PrismaClient } from './generated/prisma/client'
import { createPrismaClient } from './prisma-factory'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
