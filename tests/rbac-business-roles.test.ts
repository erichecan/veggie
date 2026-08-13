import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isKnownPermission } from '../lib/rbac/catalog'
import { API_ROUTE_RULES, PAGE_ROUTE_RULES, requiredPermissionsFor } from '../lib/rbac/route-map'

/**
 * 7 个业务角色模板（T13）。
 *
 * 这些断言守的是「岗位定义有没有被悄悄改宽」。模板之间是继承关系，
 * 往上一档加一个权限，下面几档会全部跟着变 —— 而这不会报任何错。
 */

interface BusinessRole {
  code: string
  name: string
  dataScope: 'ALL' | 'TEAM' | 'OWN'
  permissions: string[]
}

const seed = JSON.parse(readFileSync('prisma/seed-business-roles.json', 'utf-8')) as {
  roles: BusinessRole[]
}
const byCode = new Map(seed.roles.map((r) => [r.code, r]))
const perms = (code: string) => new Set(byCode.get(code)!.permissions)

test('7 个模板都在，编码与数据范围符合岗位定义', () => {
  assert.equal(seed.roles.length, 7)
  assert.equal(byCode.get('sales_manager')!.dataScope, 'TEAM', '销售经理要限本人及下属')
  assert.equal(byCode.get('external_sales_staff')!.dataScope, 'OWN', '外聘销售只能看自己的')
  for (const r of seed.roles) {
    assert.ok(r.permissions.length > 0, `${r.code} 一个权限点都没有`)
  }
})

test('模板里的权限点都真实存在', () => {
  for (const r of seed.roles) {
    const unknown = r.permissions.filter((p) => !isKnownPermission(p))
    assert.deepEqual(unknown, [], `${r.code} 引用了 catalog 里不存在的权限点`)
  }
})

test('生成物与脚本一致 —— 手改 JSON 会被这条挡住', () => {
  const before = readFileSync('prisma/seed-business-roles.json', 'utf-8')
  execFileSync('npx', ['tsx', 'scripts/rbac/generate-business-roles.ts'], { stdio: 'pipe' })
  const after = readFileSync('prisma/seed-business-roles.json', 'utf-8')
  assert.equal(after, before, '改了模板定义却没重跑生成脚本，或者有人手改了 JSON')
})

// ── 岗位定义里的关键分界线 ─────────────────────────────────────────────────

test('办公室销售：能录采购单，不能审批', () => {
  const p = perms('office_sales')
  assert.ok(p.has('purchase.order.create'), '录不了采购单，那「他们也输入购进单」就没实现')
  assert.ok(p.has('purchase.order.update'), '录完改不了自己的单，实际用不了')
  assert.ok(!p.has('purchase.order.approve'), '能批就跟高级销售没区别了')
  assert.ok(!p.has('purchase.order.receive'))
  assert.ok(p.has('sales.order.create'))
})

test('高级销售 = 办公室销售 + 采购审批，一个不少', () => {
  const office = perms('office_sales')
  const senior = perms('senior_sales')
  const lost = [...office].filter((x) => !senior.has(x))
  assert.deepEqual(lost, [], '高级销售应当包含办公室销售的全部权限')
  assert.ok(senior.has('purchase.order.approve'))
  assert.ok(senior.has('purchase.order.receive'))
})

test('销售经理 = 高级销售 + 司机与配送', () => {
  const senior = perms('senior_sales')
  const mgr = perms('sales_manager')
  const lost = [...senior].filter((x) => !mgr.has(x))
  assert.deepEqual(lost, [], '销售经理应当包含高级销售的全部权限')
  assert.ok(mgr.has('dispatch.driver_slot.manage'), '销售经理要管司机')
  assert.ok(mgr.has('analytics.commission.read'), '要能看提成考核')
})

test('仓库经理管仓不管卖', () => {
  const p = perms('warehouse_manager')
  for (const id of ['stock.receipt.create', 'stock.quality.manage', 'stock.pick.manage', 'stock.take.create']) {
    assert.ok(p.has(id), `仓库经理缺 ${id}`)
  }
  assert.ok(!p.has('sales.order.create'), '仓库经理不该能建订单')
  assert.ok(!p.has('master.product.update'), '仓库经理不该能改商品档案')
})

test('外聘销售看不到价格表与财务', () => {
  const p = perms('external_sales_staff')
  assert.ok(p.has('sales.order.create'))
  assert.ok(!p.has('master.pricelist.read'), '外聘的人不该看到价格表')
  assert.ok(!p.has('finance.invoice.read'))
  assert.ok(!p.has('sales.order.delete'))
})

test('配送中心与打印中心不碰订单内容', () => {
  for (const code of ['dispatch_center', 'print_center']) {
    const p = perms(code)
    assert.ok(!p.has('sales.order.create'), `${code} 不该能建订单`)
    assert.ok(!p.has('sales.order.update'), `${code} 不该能改订单`)
    assert.ok(p.has('sales.order.read'), `${code} 得看得到订单`)
  }
  assert.ok(perms('print_center').has('print.center.access'))
  assert.ok(perms('dispatch_center').has('dispatch.console.access'))
  // 打印中心只打，不排波次
  assert.ok(!perms('print_center').has('dispatch.wave.update'))
})

test('没有一个业务模板能配权限', () => {
  for (const r of seed.roles) {
    assert.ok(
      !r.permissions.includes('system.rbac.manage'),
      `${r.code} 拿到了 system.rbac.manage —— 这是 20260807 那起事故的形状`,
    )
  }
})

// ── 权限点要真的连到接口上，不能是装饰 ─────────────────────────────────────

/**
 * 在 handler 内部细分判定的权限点 —— route-map 看不到它们，但代码里确实有引用。
 * 下一条测试专门盯着它们别退化成装饰。
 */
const CHECKED_IN_HANDLER = ['purchase.order.approve', 'purchase.order.receive']

/**
 * ⚠️ 已知「勾了不生效」的权限点。
 *
 * catalog 里定义了它们，但没有任何 API 规则、页面规则或 handler 判定引用 ——
 * 管理员在配置页上勾了不会有任何效果。这不是 bug，是**功能还没做到那个粒度**：
 *   - `sales.order.confirm/cancel`：确认与取消都走 PUT /api/orders/[id] 改状态，
 *     和 update 同一个闸。要分开得照采购那样在 handler 里细分。
 *   - `sales.quotation.access` / `dispatch.console.access`：页面规则是按目录前缀
 *     配的（page.operator.access / page.dispatch_console.access），这两个更细的
 *     点没有对应规则。
 *   - `stock.receipt.confirm` / `purchase.plan.read` / `master.supplier.update`：
 *     对应功能的接口尚未按这个粒度拆。
 *
 * 留在模板里是有意的 —— 模板表达的是「这个岗位应该能做什么」，等功能补上就自动生效。
 * 但**这张清单只能变短，不能变长**：新增一个没人引用的点，说明又造了一个假开关。
 */
const KNOWN_INERT = [
  'sales.order.confirm',
  'sales.order.cancel',
  'sales.quotation.access',
  'stock.receipt.confirm',
  'purchase.plan.read',
  'master.supplier.update',
  'dispatch.console.access',
  // `analytics.commission.read` 于 20260812（台账 H3）接上判定，从这张清单里摘除：
  // /api/analytics/driver-commission 用它做闸门，随迁移发给 boss / operator。
]

/** 规则里的 permission 可能是单个、数组（任一即可），或 null（无需权限） */
function referencedPermissions(): Set<string> {
  const out = new Set<string>()
  for (const rule of [...API_ROUTE_RULES, ...PAGE_ROUTE_RULES]) {
    const p = rule.permission
    if (p === null || p === undefined) continue
    if (typeof p === 'string') out.add(p)
    else for (const one of p) out.add(one)
  }
  return out
}

test('模板里没有新增的「勾了不生效」权限点', () => {
  const referenced = referencedPermissions()
  for (const id of [...CHECKED_IN_HANDLER, ...KNOWN_INERT]) referenced.add(id)

  const orphans = new Set<string>()
  for (const r of seed.roles) {
    for (const id of r.permissions) if (!referenced.has(id)) orphans.add(id)
  }
  assert.deepEqual(
    [...orphans],
    [],
    '这些权限点没有任何接口引用 —— 在配置页上勾了它什么也不会发生，比没有更糟。' +
      '要么把它接到判定上，要么从模板里去掉，要么登记进 KNOWN_INERT 并写清为什么。',
  )
})

test('KNOWN_INERT 只能变短：已接上判定的点要从清单里删掉', () => {
  const referenced = referencedPermissions()
  for (const id of CHECKED_IN_HANDLER) referenced.add(id)

  const stale = KNOWN_INERT.filter((id) => referenced.has(id))
  assert.deepEqual(stale, [], '这些点已经有判定引用了，从 KNOWN_INERT 里删掉，别让豁免继续挂着')
})

test('采购审批的细分判定确实写在 handler 里', () => {
  const src = readFileSync('app/api/purchase-orders/[id]/route.ts', 'utf-8')
  assert.ok(/purchase\.order\.approve/.test(src), 'FINER_GATE 里没有 approve')
  assert.ok(/purchase\.order\.receive/.test(src), 'FINER_GATE 里没有 receive')
  assert.ok(/userHasPermission/.test(src), '没有真的做判定，只是写了个常量')
  // 端点本身仍然要求 update —— 细分判定是在它之上再加一道，不是替代
  assert.deepEqual(
    requiredPermissionsFor(API_ROUTE_RULES, '/api/purchase-orders/x', 'PATCH'),
    ['purchase.order.update'],
  )
})

test('补 approve/receive 的迁移只动预置角色', () => {
  // 这条迁移跑在建业务模板之后。不加 isSystem 条件的话，它会把「办公室销售」
  // 刚拆出来的「能录不能批」又抹平 —— 实测过，43 个权限点会变成 45 个。
  const sql = readFileSync(
    'prisma/migrations/20260807000004_purchase_approve_finer_gate/migration.sql',
    'utf-8',
  )
  assert.ok(
    /WHERE\s+"isSystem"\s*=\s*true/.test(sql),
    '缺 isSystem 条件，业务角色模板会被一起改宽',
  )
})

test('改造前就能审批的角色仍然能审批', () => {
  // 拆细动作最容易造成的伤害不是「谁多了权限」，而是「所有人都少了一个能力」
  const rbac = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as {
    roles: Array<{ legacyRole: string; permissions: string[] }>
  }
  for (const r of rbac.roles) {
    if (!r.permissions.includes('purchase.order.update')) continue
    assert.ok(
      r.permissions.includes('purchase.order.approve'),
      `${r.legacyRole} 改造前有 update 就能审批，拆细后却拿不到 approve —— 审批功能对它断了`,
    )
    assert.ok(r.permissions.includes('purchase.order.receive'), `${r.legacyRole} 同上，收货断了`)
  }
})
