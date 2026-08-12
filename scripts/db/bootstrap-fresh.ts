/**
 * 从空库建起一个可用的数据库
 * ============================================================================
 * 台账 Z6。存在的理由是一个必须知道的事实：
 *
 *   ⛔ **`prisma migrate deploy` 无法从空库建库。**
 *
 * 迁移链**没有基线**：`ProductTemplate` / `Product` / `Customer` / `Order` /
 * `User` 这些核心表没有任何迁移创建过（69 个迁移里只有 18 个含 CREATE TABLE，
 * 全是 20260419 之后新增的表）。链条第一个迁移上来就 `ALTER TABLE
 * "ProductTemplate"`，在空库上必然报 `relation does not exist`，且该错误会被
 * 「current transaction is aborted」掩盖，看起来像是那个迁移写错了。
 *
 * 换句话说：迁移链**只支持增量演进**，不支持重建。这一点对私有化部署有直接
 * 影响 —— 客户服务器若需从零起步，必须走本脚本这条路，不能指望 migrate deploy。
 *
 * 本脚本固化的是已验证可行的路径：
 *   1. db push        直接把 schema 同步成表结构（跳过迁移链）
 *   2. 视图/扩展/索引   视图与 pg_trgm 写在迁移 SQL 里，db push 同样跳过 →
 *                     不补的话 /api/analytics/* 直接 500（v_lot_daily_cost 不存在）
 *   3. RBAC 数据迁移   角色与权限点是写在数据迁移里的，db push 会跳过 → 必须补
 *   4. 基础种子        用户/商品/客户/价格表
 *   5. 事件种子        订单/发票/收付款/库存流水（可选，--with-events）
 *   6. 期初库存        把商品补到可下单的库存水位（可选，--with-stock）
 *
 * ⛔ 只允许打向本机。这个脚本会 db push，对生产库执行等同于结构性重写。
 *
 * 用法：
 *   npx tsx --env-file=.env.test scripts/db/bootstrap-fresh.ts
 *   npx tsx --env-file=.env.test scripts/db/bootstrap-fresh.ts --with-events --with-stock
 */
import { execFileSync } from 'node:child_process'

const steps: Array<{ name: string; run: () => void; optional?: string }> = []

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit', env: process.env })
}

function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL 未设置。用 --env-file 指定环境文件。')
    process.exit(1)
  }
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 目标库不是本机地址。本脚本会执行 db push（结构性重写），只允许打向本地库。')
    console.error(`   当前指向：${url.replace(/:\/\/[^@]*@/, '://***@')}`)
    process.exit(1)
  }

  const withEvents = process.argv.includes('--with-events')
  const withStock = process.argv.includes('--with-stock')

  steps.push({
    name: '1/6 同步表结构（db push —— 刻意绕开无基线的迁移链）',
    run: () => sh('npx', ['prisma', 'db', 'push']),
  })
  steps.push({
    name: '2/6 补视图/扩展/trgm 索引（db push 同样跳过，不补则分析中心 500）',
    run: () => sh('npx', ['tsx', 'scripts/db/apply-sql-objects.ts']),
  })
  steps.push({
    name: '3/6 补 RBAC 数据迁移（db push 会跳过，不补则全站 403）',
    run: () => sh('npx', ['tsx', 'scripts/rbac/apply-data-migrations.ts']),
  })
  steps.push({
    name: '4/6 基础种子（用户/商品/客户/价格表）',
    run: () => sh('npx', ['tsx', 'prisma/seed.ts']),
  })
  if (withEvents) {
    steps.push({
      name: '5/6 事件种子（订单/发票/收付款/库存流水）',
      run: () => sh('npx', ['tsx', 'prisma/seed-events/index.ts']),
    })
  }
  if (withStock) {
    steps.push({
      name: '6/6 期初库存（把商品补到可下单水位）',
      run: () => sh('npx', ['tsx', 'scripts/seed/ensure-opening-stock.ts']),
    })
  }

  for (const s of steps) {
    console.log(`\n──── ${s.name}`)
    s.run()
  }

  console.log('\n✅ 完成。建议接着跑：npx tsx scripts/validate-data.ts')
  if (!withEvents) console.log('   （加 --with-events 可生成订单/发票/收付款等业务数据）')
  if (!withStock) console.log('   （加 --with-stock 可把商品补到可下单库存水位）')
}

main()
