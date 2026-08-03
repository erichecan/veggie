/**
 * 数据库驱动选择 —— 纯函数
 * ============================================================================
 * 单独成文件而不是放在 `lib/db.ts` 里，有两个原因：
 *
 * 1. `lib/db.ts` 在模块加载时就会构造 PrismaClient。把选择逻辑放那里，测一个
 *    字符串函数就得连带加载整个 Prisma client，而测试环境没有 DATABASE_URL——
 *    模块加载即抛，测试自己先死。
 * 2. 选择逻辑要在**连接之前**就能判定并报错，它天然不依赖任何连接。
 */

export type DatabaseDriverName = 'neon' | 'pg'

/**
 * 决定用哪个 driver，不触发任何连接。
 *
 *   neon —— Neon serverless（WebSocket）。回滚窗口内 Cloud Run 仍在用。
 *   pg   —— 标准 PostgreSQL（libpq/TCP 或 unix socket）。迁移后的目标形态。
 *
 * 未显式指定时按连接串推断。拼错的值直接抛而不是静默回退：把 DATABASE_DRIVER
 * 写成 "postgres" 却回退成 neon，在客户服务器上的表现是启动时 WebSocket 连接
 * 超时，错误信息完全指不到根因。
 */
export function resolveDatabaseDriver(
  rawDriver: string | undefined,
  url: string | undefined,
): DatabaseDriverName {
  const v = (rawDriver ?? '').trim().toLowerCase()
  if (v === 'neon' || v === 'pg') return v
  if (v !== '') {
    throw new Error(`DATABASE_DRIVER 只能是 neon / pg，收到 "${rawDriver}"`)
  }
  if (!url) {
    throw new Error('DATABASE_URL 未设置，无法推断数据库驱动（也可显式指定 DATABASE_DRIVER）')
  }
  return url.includes('neon.tech') ? 'neon' : 'pg'
}
