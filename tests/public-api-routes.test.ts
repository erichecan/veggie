/**
 * 锁住「哪些 API 匿名可达」。
 *
 * 由来：2026-08-02 审计发现 `/api/customers` 因一次「修 /enter 404」被顺手加进
 * middleware 白名单，全量客户名册（1605 条，含地址/电话/邮箱/VAT/信用额度/提成率）
 * 匿名可读了两个月没人发现。白名单是前缀匹配，加一条会带上整棵子树，
 * 而当时没有任何测试会因此变红。
 *
 * 这个测试不只断言白名单内容——它扫描 `app/api` 下**全部**路由，算出 middleware
 * 会放行哪些，与下面的快照逐条比对。新增路由若落进公开范围，测试立刻失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_API_ROUTES, isPublicApiRoute } from '../lib/public-routes'

/**
 * 允许匿名访问的路由快照。
 *
 * ⚠️ 改动这个数组前先回答：这个接口会不会吐出任何客户、订单、商品、价格、财务或配置数据？
 * 只要答案不是斩钉截铁的「不会」，就不该加。加的时候必须在这里写清理由。
 */
const EXPECTED_PUBLIC: Record<string, string> = {
  '/api/auth/login': '登录本身，必须匿名可达；自带 rateLimit 防爆破',
  '/api/health': '只回 {ok:true} 与时间戳，无业务数据',
  '/api/tile': '地图瓦片代理，纯转发第三方瓦片',
  '/api/cron/backup-database': '定时任务，自带 CRON_SECRET 校验，不走 JWT',
}

/** 扫 app/api，把每个 route.ts 还原成 URL 路径 */
function listApiRoutes(dir = 'app/api', prefix = '/api'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listApiRoutes(full, `${prefix}/${entry}`))
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      out.push(prefix)
    }
  }
  return out
}

test('app/api 下能扫到路由（扫描逻辑本身没坏）', () => {
  const routes = listApiRoutes()
  assert.ok(routes.length > 100, `只扫到 ${routes.length} 个路由，扫描逻辑可能失效`)
  assert.ok(routes.includes('/api/health'), '应当扫到 /api/health')
  assert.ok(routes.includes('/api/customers'), '应当扫到 /api/customers')
})

test('匿名可达的 API 路由集合与快照完全一致', () => {
  const actual = listApiRoutes().filter(isPublicApiRoute).sort()
  const expected = Object.keys(EXPECTED_PUBLIC).sort()

  const added = actual.filter(r => !expected.includes(r))
  const removed = expected.filter(r => !actual.includes(r))

  assert.deepEqual(
    actual,
    expected,
    `匿名可达路由发生变化。\n` +
    (added.length ? `  新增公开（危险，除非确认无业务数据）: ${added.join(', ')}\n` : '') +
    (removed.length ? `  不再公开: ${removed.join(', ')}\n` : '') +
    `  若属预期，请同步更新 tests/public-api-routes.test.ts 的 EXPECTED_PUBLIC 并写清理由。`,
  )
})

test('客户/订单/商品/财务等敏感前缀绝不在白名单里', () => {
  const forbidden = [
    '/api/customers', '/api/orders', '/api/products', '/api/product-templates',
    '/api/invoices', '/api/payments', '/api/purchase-orders', '/api/analytics',
    '/api/users', '/api/accounts', '/api/backups', '/api/statements',
    '/api/customer-portal', '/api/trips', '/api/waves', '/api/pricelists',
  ]
  for (const p of forbidden) {
    assert.equal(
      isPublicApiRoute(p), false,
      `${p} 被 middleware 放行为公开接口——这会泄露业务数据`,
    )
    // 子路径同样不能被前缀匹配放行
    assert.equal(
      isPublicApiRoute(`${p}/anything`), false,
      `${p}/anything 被放行——白名单是前缀匹配，加错一条会带上整棵子树`,
    )
  }
})

test('白名单里每一条都在快照里有书面理由', () => {
  for (const route of PUBLIC_API_ROUTES) {
    const documented = Object.keys(EXPECTED_PUBLIC).some(r => r.startsWith(route))
    assert.ok(documented, `白名单条目 ${route} 在 EXPECTED_PUBLIC 里没有对应说明`)
  }
})
