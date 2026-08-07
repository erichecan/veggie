import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { canEnterPage } from '../lib/rbac/page-guard'
import { encodePermissions } from '../lib/rbac/bitmap'
import { canRolesAccessPage } from '../lib/role-access'

interface SeedRole {
  legacyRole: string
  permissions: string[]
}
const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as { roles: SeedRole[] }
const bitmapOf = new Map(seed.roles.map((r) => [r.legacyRole, encodePermissions(r.permissions)]))

const PAGES: Array<[string, string[]]> = [
  ['/classic/operator', ['OPERATOR']],
  ['/classic/boss', ['BOSS', 'OPERATOR']],
  ['/classic/finance', ['FINANCE', 'OPERATOR', 'BOSS']],
  ['/classic/accounting', ['FINANCE', 'OPERATOR']],
  ['/classic/warehouse', ['WAREHOUSE', 'OPERATOR', 'BOSS']],
  ['/classic/sorter', ['SORTER', 'OPERATOR']],
  ['/classic/driver', ['DRIVER', 'OPERATOR']],
  ['/classic/print', ['OPERATOR', 'BOSS', 'FINANCE', 'DISPATCH', 'SALES']],
  ['/classic/restaurant', ['RESTAURANT']],
]

test('没有会话一律进不去', () => {
  for (const [page, legacy] of PAGES) {
    assert.ok(!canEnterPage(null, page, legacy))
    assert.ok(!canEnterPage(undefined, page, legacy))
  }
})

/**
 * ⛔ 部署后没重新登录的人，会话里没有位图。这条路径断了他们会被自己的页面踢出去。
 */
test('旧会话（无位图）按 legacy 名单判', () => {
  for (const [page, legacy] of PAGES) {
    for (const role of legacy) {
      assert.ok(canEnterPage({ role, roles: [role] }, page, legacy), `${role} 应能进 ${page}`)
    }
    assert.ok(!canEnterPage({ role: 'NOBODY', roles: ['NOBODY'] }, page, legacy))
  }
})

/**
 * 老写法是 `['FINANCE','OPERATOR'].includes(user.role)` —— 只看主角色单值。
 * 现网 19 个 SALES 全部兼任 OPERATOR，这类账号的兼任角色以前是白兼的。
 */
test('旧会话也按 roles[] 判，不再只看主角色', () => {
  const dualRole = { role: 'SALES', roles: ['SALES', 'OPERATOR'] }
  assert.ok(
    canEnterPage(dualRole, '/classic/operator', ['OPERATOR']),
    '兼任 OPERATOR 的账号应该进得去，哪怕主角色不是 OPERATOR',
  )
  assert.ok(!canEnterPage({ role: 'SALES', roles: ['SALES'] }, '/classic/warehouse', ['WAREHOUSE']))
})

test('新会话（位图）判定与 middleware 的页面规则一致', () => {
  const diffs: string[] = []
  for (const [page, legacy] of PAGES) {
    for (const [role, pm] of bitmapOf) {
      const viaGuard = canEnterPage({ role, roles: [role], pm }, page, legacy)
      const viaMiddleware = canRolesAccessPage([role], page)
      if (viaGuard !== viaMiddleware) {
        diffs.push(`${page} [${role}]: layout ${viaGuard} / middleware ${viaMiddleware}`)
      }
    }
  }
  // layout 与 middleware 用同一张 route-map，不该出现「middleware 放行但 layout 踢人」
  assert.deepEqual(diffs, [], 'layout 与 middleware 的页面判定不一致')
})

/**
 * 8/6 审计的未解决问题：/classic/print 的 layout 没有任何判定，全靠 middleware
 * 的 matcher 兜着。打印中心里是整天的销售单、拣货单、配送单，含客户与价格。
 */
test('每个 classic layout 都有页面守卫', () => {
  const dir = 'app/[locale]/classic'
  const missing: string[] = []
  for (const name of readdirSync(dir)) {
    const file = `${dir}/${name}/layout.tsx`
    let src: string
    try { src = readFileSync(file, 'utf-8') } catch { continue }
    if (!src.includes('canEnterPage')) missing.push(name)
  }
  assert.deepEqual(missing, [], '这些 layout 没有页面守卫，绕过 middleware 就敞开了')
})
