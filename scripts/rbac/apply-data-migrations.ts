/**
 * 把 RBAC 的**数据**迁移补到一个用 `db push` 建起来的库上。
 * ============================================================================
 * 为什么需要它：
 *
 * RBAC 的角色与权限点不在 `prisma/seed.ts` 里，而是写成了数据迁移
 * （见 scripts/rbac/generate-seed-migration.ts 的说明：部署链路是
 * `push main → Actions → migrate deploy`，压根不跑 seed）。
 *
 * 而本项目的历史迁移链**无法在空库上重放**（见台账 Z6），所以重建测试库只能走
 * `prisma db push`—— 它只同步 schema，**跳过全部迁移**，于是 AppRole /
 * Permission / UserRoleLink 三张表是空的。
 *
 * 后果不是「权限没配」这么温和：`encodePermissions([])` 返回的是**定长全零串**，
 * 而 `hasBitmap()` 只判断该串是否非空 —— 于是系统认为「这个用户有位图，且一个
 * 权限都没有」，所有带鉴权的 API 一律 403、所有受保护页面一律弹走。表现像是
 * 登录坏了，实际是权限集为空。
 *
 * 本脚本只补数据迁移（000001 起）。000000 是纯 DDL，`db push` 已经建好了表，
 * 重复执行会撞 "type already exists"。
 *
 * 用法：
 *   npx tsx --env-file=.env.test scripts/rbac/apply-data-migrations.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

/** 顺序即依赖顺序，不要重排 */
const DATA_MIGRATIONS = [
  '20260807000001_rbac_seed_system_roles',
  '20260807000002_rbac_reset_role_permissions',
  '20260807000003_rbac_business_role_templates',
  '20260807000004_purchase_approve_finer_gate',
  '20260807000005_rbac_preset_role_display_names',
  '20260812000001_rbac_driver_commission_grant',
]

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL 未设置。用 --env-file 指定环境文件。')
    process.exit(1)
  }
  // 刻意不走 `prisma db execute`：那条命令从 prisma.config.ts 读数据源，而它会
  // 自动注入 .env.local —— 一旦覆盖掉这里校验过的 URL，就可能打到生产库上，
  // 而下面这道 localhost 闸门还以为自己拦住了。直连 pg，用的就是校验过的那个 URL。
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 目标库不是本机地址。本脚本只允许打向本地测试库，避免误改生产。')
    console.error(`   当前 DATABASE_URL 指向：${url.replace(/:\/\/[^@]*@/, '://***@')}`)
    process.exit(1)
  }

  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    for (const name of DATA_MIGRATIONS) {
      const file = path.join('prisma', 'migrations', name, 'migration.sql')
      if (!existsSync(file)) {
        console.error(`✗ ${name} —— 找不到 ${file}`)
        process.exit(1)
      }
      process.stdout.write(name.padEnd(48))
      try {
        await client.query(readFileSync(file, 'utf-8'))
        console.log('✅')
      } catch (e) {
        console.log('❌')
        console.error(String((e as Error).message).slice(0, 400))
        process.exit(1)
      }
    }
  } finally {
    await client.end()
  }
  console.log('\n完成。验证：登录后 JWT 的 pm 应为非零位图，带鉴权 API 应返回 200。')
}

main().catch(e => { console.error(e); process.exit(1) })
