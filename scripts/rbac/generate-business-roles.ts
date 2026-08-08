/**
 * 生成 7 个业务角色模板（台账 T13）。
 * ============================================================================
 * 这 7 个角色对应客户在需求里描述的实际岗位，与平迁进来的 12 个 legacy 角色是
 * 两回事：legacy 角色是「现网账号原本能做什么」的快照，业务角色是「这个岗位
 * 应该能做什么」的定义。
 *
 * ⛔ 只建角色，不动现有 51 个账号的分配（决策 4：先平迁）。上线后由管理员在
 *    配置页里一个一个改过去 —— 自动分配的话，一次部署就把全公司的权限重排了，
 *    出了问题连"原来是什么样"都查不回来。
 *
 * 每个模板都在这里用 模块 → 动作 的形式声明，脚本负责：
 *   1. 逐个校验权限点在 catalog 里真实存在（写错一个字母就是一条静默失效的权限）
 *   2. 校验「不该有的权限确实没有」—— 比如办公室销售不能有 purchase.order.approve
 *   3. 生成幂等迁移 SQL
 *
 * 用法：npx tsx scripts/rbac/generate-business-roles.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { PERMISSIONS, isKnownPermission } from '../../lib/rbac/catalog'

type Scope = 'ALL' | 'TEAM' | 'OWN'

interface Template {
  code: string
  name: string
  description: string
  dataScope: Scope
  /** 模块 → 动作。`'*'` 表示该模块下全部动作 */
  grant: Record<string, string[] | '*'>
  /** 从 grant 里再摘掉的权限点（用于「继承自上一档，但少这几样」） */
  exclude?: string[]
  /** 必须**不**包含的权限点 —— 岗位定义里最关键的那几条否定，写下来才守得住 */
  mustNotHave: string[]
  /** 继承自哪个模板（先并上它的 grant） */
  extends?: string
}

const ACTIONS_BY_MODULE = new Map<string, string[]>()
for (const p of PERMISSIONS) {
  const arr = ACTIONS_BY_MODULE.get(p.module) ?? []
  arr.push(p.action)
  ACTIONS_BY_MODULE.set(p.module, arr)
}

// ── 岗位定义（设计文档 §4「岗位映射」）─────────────────────────────────────
const TEMPLATES: Template[] = [
  {
    code: 'office_sales',
    name: '办公室销售',
    description: '录订单、录采购单；不能审批采购',
    dataScope: 'ALL',
    grant: {
      'sales.order': ['read', 'create', 'update', 'delete', 'confirm', 'cancel',
                      'print', 'dispatch_print', 'read_audit', 'write_audit', 'export', 'delete_line'],
      'sales.quotation': '*',
      'sales.daily_report': ['read'],
      'sales.discrepancy': ['read'],
      'sales.workbench': '*',
      // 「能录不能批」—— 有 update 能改自己录错的单，但 approve / receive 不在这里。
      // 这两个动作与 update 走同一个 PATCH 端点，靠 handler 里的细分判定分开
      // （app/api/purchase-orders/[id]/route.ts 的 FINER_GATE）。
      'purchase.order': ['read', 'create', 'update', 'print'],
      'stock.quality': ['read'],
      'dispatch.wave': ['read'],
      'dispatch.driver_slot': ['read'],
      'finance.invoice': ['read'],
      'master.customer': ['read', 'create', 'update', 'read_detail', 'read_credit', 'read_last_prices'],
      'master.product': ['read', 'read_detail', 'read_price_history'],
      'master.pricelist': ['read', 'print'],
      'master.supplier': ['read'],
      'master.uom': ['read'],
      'master.product_template': ['read'],
      'master.product_category': ['read'],
      'print.center': '*',
      'page.operator': '*',
      'page.print': '*',
      'system.mfa': '*',
    },
    mustNotHave: [
      'purchase.order.approve',
      'purchase.order.receive',
      'system.rbac.manage',
      'system.user.manage',
    ],
  },
  {
    code: 'senior_sales',
    name: '高级销售',
    description: '办公室销售的全部，另外直接负责采购（可审批、可收货）',
    dataScope: 'ALL',
    extends: 'office_sales',
    grant: {
      'purchase.order': '*',
      'purchase.suggestion': '*',
      'purchase.plan': '*',
      'purchase.legacy': ['read', 'create'],
      'master.supplier': ['read', 'create', 'update'],
      'analytics.purchase': '*',
      'analytics.sales': '*',
    },
    mustNotHave: ['system.rbac.manage', 'system.user.manage'],
  },
  {
    code: 'sales_manager',
    name: '销售经理',
    description: '销售 + 采购 + 司机；数据范围限本人及下属',
    dataScope: 'TEAM',
    extends: 'senior_sales',
    grant: {
      'dispatch.console': '*',
      'dispatch.wave': '*',
      'dispatch.trip': '*',
      'dispatch.driver_slot': '*',
      'dispatch.driver_summary': '*',
      'dispatch.batch_analysis': '*',
      'analytics.commission': '*',
      'analytics.margin': '*',
      'analytics.logistics': '*',
      'analytics.report': ['read'],
      'page.dispatch_console': '*',
      'system.user': ['read'],
    },
    mustNotHave: ['system.rbac.manage', 'finance.payment.create'],
  },
  {
    code: 'warehouse_manager',
    name: '仓库经理',
    description: '卸货、质检、配货出库、库存管理',
    dataScope: 'ALL',
    grant: {
      'stock.receipt': '*',
      'stock.quality': '*',
      'stock.pick': '*',
      'stock.move': '*',
      'stock.take': '*',
      'stock.lot': '*',
      'stock.zone': '*',
      'stock.scrap': '*',
      'sales.order': ['read'],
      'purchase.order': ['read', 'receive', 'print'],
      'purchase.legacy': ['read', 'create'],
      'dispatch.wave': ['read', 'read_detail'],
      'master.product': ['read', 'read_detail', 'read_price_history'],
      'master.uom': ['read'],
      'master.uom_category': ['read'],
      'master.product_template': ['read'],
      'master.product_category': ['read'],
      'analytics.inventory': '*',
      'page.warehouse': '*',
      'system.notification': '*',
      'system.mfa': '*',
    },
    mustNotHave: [
      'sales.order.create', 'sales.order.update',
      'purchase.order.approve',
      'master.product.update',
      'system.rbac.manage',
    ],
  },
  {
    code: 'external_sales_staff',
    name: '外聘销售',
    description: '只录自己的订单；看不到别人的单，也看不到价格表与财务',
    dataScope: 'OWN',
    grant: {
      'sales.order': ['read', 'create', 'update', 'print', 'read_audit', 'write_audit'],
      'sales.quotation': '*',
      'stock.quality': ['read'],
      'master.customer': ['read', 'create', 'read_detail', 'read_credit', 'read_last_prices'],
      'master.product': ['read', 'read_detail', 'read_price_history'],
      'master.uom': ['read'],
      'master.product_template': ['read'],
      'master.product_category': ['read'],
      'page.operator': '*',
      'system.mfa': '*',
    },
    mustNotHave: [
      'master.pricelist.read',
      'finance.invoice.read',
      'sales.order.delete',
      'purchase.order.create',
      'system.rbac.manage',
    ],
  },
  {
    code: 'dispatch_center',
    name: '配送中心',
    description: '排波次、派车、跟车；不碰订单内容与价格',
    dataScope: 'ALL',
    grant: {
      'dispatch.console': '*',
      'dispatch.wave': '*',
      'dispatch.trip': '*',
      'dispatch.driver_slot': '*',
      'dispatch.driver_summary': '*',
      'dispatch.batch_analysis': '*',
      'sales.order': ['read', 'assign_batch', 'mark_printed', 'dispatch_print'],
      'sales.discrepancy': '*',
      'stock.pick': '*',
      'stock.quality': ['read', 'manage'],
      'master.customer': ['read'],
      'master.product': ['read'],
      'analytics.logistics': '*',
      'print.center': '*',
      'page.dispatch_console': '*',
      'page.print': '*',
      'tool.geo': '*',
      'system.mfa': '*',
    },
    mustNotHave: [
      'sales.order.create', 'sales.order.update', 'sales.order.delete',
      'master.pricelist.read',
      'finance.invoice.read',
      'system.rbac.manage',
    ],
  },
  {
    code: 'print_center',
    name: '打印中心',
    description: '只打单：拣货单、配送单、发票的打印视图',
    dataScope: 'ALL',
    grant: {
      'print.center': '*',
      'sales.order': ['read', 'print', 'dispatch_print', 'mark_printed'],
      'dispatch.wave': ['read', 'read_detail', 'print_log'],
      'dispatch.trip': ['read', 'print'],
      'master.customer': ['read'],
      'master.product': ['read'],
      'page.print': '*',
      'system.mfa': '*',
    },
    mustNotHave: [
      'sales.order.create', 'sales.order.update', 'sales.order.delete',
      'dispatch.wave.update', 'dispatch.trip.update',
      'system.rbac.manage',
    ],
  },
]

// ── 展开与校验 ─────────────────────────────────────────────────────────────
function expand(grant: Record<string, string[] | '*'>, where: string): string[] {
  const out: string[] = []
  for (const [module, actions] of Object.entries(grant)) {
    const known = ACTIONS_BY_MODULE.get(module)
    if (!known) {
      throw new Error(`[${where}] 模块 ${module} 在 catalog 里不存在`)
    }
    const list = actions === '*' ? known : actions
    for (const a of list) {
      const id = `${module}.${a}`
      if (!isKnownPermission(id)) {
        throw new Error(`[${where}] 权限点 ${id} 在 catalog 里不存在（模块有这些动作：${known.join(' ')}）`)
      }
      out.push(id)
    }
  }
  return out
}

const built = new Map<string, { tpl: Template; permissions: string[] }>()
const problems: string[] = []

for (const tpl of TEMPLATES) {
  const own = expand(tpl.grant, tpl.code)
  const base = tpl.extends ? (built.get(tpl.extends)?.permissions ?? []) : []
  if (tpl.extends && base.length === 0) {
    throw new Error(`${tpl.code} 继承的 ${tpl.extends} 还没定义（模板顺序不对）`)
  }
  const set = new Set([...base, ...own])
  for (const id of tpl.exclude ?? []) set.delete(id)

  // catalog 顺序，让 SQL 与页面显示都稳定
  const order = new Map(PERMISSIONS.map((p, i) => [p.id, i]))
  const permissions = [...set].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))

  // ⛔ 岗位定义里的否定条款：继承会把上一档的权限带下来，写错了不会报错，
  //    只会表现为「这个岗位悄悄多了个能力」。这里逐条挡住。
  for (const id of tpl.mustNotHave) {
    if (!isKnownPermission(id)) problems.push(`${tpl.code}: mustNotHave 里的 ${id} 不是真权限点`)
    if (permissions.includes(id)) problems.push(`${tpl.code}: 不该有 ${id}，但继承/授予后有了`)
  }

  built.set(tpl.code, { tpl, permissions })
}

if (problems.length > 0) {
  console.error('❌ 模板定义有问题：')
  problems.forEach((p) => console.error('   ' + p))
  process.exit(1)
}

// ── 输出 ───────────────────────────────────────────────────────────────────
const json = {
  generatedFrom: 'scripts/rbac/generate-business-roles.ts',
  roles: [...built.values()].map(({ tpl, permissions }) => ({
    code: tpl.code,
    name: tpl.name,
    description: tpl.description,
    dataScope: tpl.dataScope,
    permissions,
  })),
}
writeFileSync('prisma/seed-business-roles.json', JSON.stringify(json, null, 2) + '\n', 'utf-8')

const sqlEscape = (s: string) => s.replace(/'/g, "''")
const lines: string[] = [
  '-- 7 个业务角色模板（台账 T13）',
  '--',
  '-- 由 scripts/rbac/generate-business-roles.ts 生成，不要手改这个文件。',
  '-- 这些是「岗位应该能做什么」的定义，与平迁进来的 12 个 legacy 角色是两回事。',
  '--',
  '-- ⛔ 只建角色，不动任何账号的分配 —— 现有 51 个账号继续用平迁来的 legacy 角色，',
  '--    由管理员在权限中心里一个一个改过去（决策 4）。因此本迁移**不**动 permVersion，',
  '--    没有人会被踢下线。',
  '--',
  '-- isSystem = false：这些是模板，管理员可以改、可以删、可以复制出变体。',
  '-- ON CONFLICT DO NOTHING：重跑不覆盖管理员已经调过的权限。',
  '',
]
for (const { tpl, permissions } of built.values()) {
  const arr = permissions.map((p) => `'${p}'`).join(',')
  lines.push(
    `INSERT INTO "AppRole" ("id","code","name","description","isSystem","dataScope","permissions","createdAt","updatedAt")\n` +
      `VALUES (gen_random_uuid()::TEXT, '${tpl.code}', '${sqlEscape(tpl.name)}', '${sqlEscape(tpl.description)}', false, '${tpl.dataScope}'::"DataScope", ARRAY[${arr}]::TEXT[], NOW(), NOW())\n` +
      `ON CONFLICT ("code") DO NOTHING;`,
  )
  lines.push('')
}

const dir = 'prisma/migrations/20260807000003_rbac_business_role_templates'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/migration.sql`, lines.join('\n'), 'utf-8')

console.log('7 个业务角色模板已生成：\n')
for (const { tpl, permissions } of built.values()) {
  console.log(`  ${tpl.code.padEnd(22)} ${String(permissions.length).padStart(3)} 个权限点  范围 ${tpl.dataScope}  ${tpl.name}`)
}
console.log(`\n  → prisma/seed-business-roles.json`)
console.log(`  → ${dir}/migration.sql`)
