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
import { PrismaClient } from './generated/prisma/client'
import { resolveDatabaseDriver } from './db-driver'

/**
 * ⛔ 驱动包一律**懒加载**，不要改回顶层 import。
 * ============================================================================
 * 之前这里是 `import { neonConfig } from '@neondatabase/serverless'` 等四个静态
 * import。Next 运行时没事（webpack 把它们打进 chunk 了），但**在生产容器里直接
 * 跑 TS 脚本就一路炸**：
 *
 *   docker exec veggie-app-1 npx tsx scripts/audit/xxx.ts
 *   → Cannot find module '@neondatabase/serverless'（栈顶 lib/prisma-factory.ts）
 *
 * 因为运行时镜像只有 `.next/standalone`，它的 node_modules 是 nft 追踪出来的裁剪
 * 结果 —— 被 webpack 内联掉的包不会留在里面。实测该目录下**四个驱动包一个都没有**：
 * `@neondatabase/serverless`、`@prisma/adapter-neon`、`@prisma/adapter-pg` 全缺
 * （`pg` / `ws` 反倒在，它们是适配器的传递依赖被追踪到了）。
 *
 * 于是 `scripts/audit/` 下所有脚本在生产一律不可用 —— 而它们正是出事时最该能跑的
 * 东西。X6 订正生产数据时被迫把脚本逻辑手工翻译成 SQL，翻译本身就是出错的机会。
 *
 * 两件事一起做才修得好，缺一不可：
 *
 *  1. **本文件按 driver 懒加载**（下面）—— 走 pg 时一个字节的 Neon 代码都不加载。
 *     ⛔ 不许改成"在生产把 Neon 包装回去"：Neon 是要拆掉的架构，给它加钉子违反
 *     部署铁律。
 *  2. **`next.config.ts` 的 outputFileTracingIncludes 显式带上 `@prisma/adapter-pg`**
 *     —— 光懒加载不够，因为生产走的 pg 分支所需的适配器包同样被裁掉了。
 *     只往产物里多拷文件，不改 app 自身的打包/解析方式（那才是全站连库的风险面）。
 *
 * 用 `require()` 而不是 `await import()`：本函数是同步的，60+ 个脚本与 lib/db.ts
 * 都直接调它，改成 async 会顺着传染整棵调用树。
 */

/**
 * 按 `DATABASE_DRIVER` / 连接串建一个 PrismaClient。
 *
 * 没有连接串时不判定、不抛错，回落到 neon（保持改造前行为）：选哪个 adapter 都
 * 一样会在首次查询失败，而在模块加载阶段抛会打死那些间接 import 到本文件却从不
 * 查库的测试。
 */
/* eslint-disable @typescript-eslint/no-require-imports --
 * 这里的 require() 是本次修复的**全部要点**，不是图省事。
 * no-require-imports 的本意是"别用旧写法"，但它表达不了"必须晚于模块加载、
 * 且只加载选中的那一个驱动"这个约束：改成顶层 import 就等于把 X8 原样改回去，
 * 生产容器里的审计脚本会重新全部 MODULE_NOT_FOUND。
 * 也不能换成 `await import()` —— 本函数是同步的，60+ 个脚本与 lib/db.ts 直接调它。
 * 有 tests/prisma-factory-lazy-driver.test.ts 在运行时盯着，不靠这条 lint 规则守。
 */
export function createPrismaClient(
  connectionString: string | undefined = process.env.DATABASE_URL,
): PrismaClient {
  const driver = connectionString
    ? resolveDatabaseDriver(process.env.DATABASE_DRIVER, connectionString)
    : 'neon'

  if (driver === 'pg') {
    const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg')
    // PrismaPg 接受 pg.Pool | pg.PoolConfig | string，这里给 PoolConfig
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) })
  }

  const { neonConfig } = require('@neondatabase/serverless') as typeof import('@neondatabase/serverless')
  const { PrismaNeon } = require('@prisma/adapter-neon') as typeof import('@prisma/adapter-neon')
  // ws 的类型是 `export = WebSocket`，命名空间本身不是构造器 ——
  // 取 default 才等价于原来的 `import ws from 'ws'`
  const ws = require('ws') as (typeof import('ws'))['default']
  // WebSocket 构造器只在真的走 neon 时才装配
  neonConfig.webSocketConstructor = ws
  // PrismaNeon expects a PoolConfig (connection config), not a Pool instance
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString: connectionString! }) })
}
/* eslint-enable @typescript-eslint/no-require-imports */
