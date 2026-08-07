/**
 * 权限点目录 —— 可配置权限体系的**唯一真相**
 * ============================================================================
 * 设计见 docs/20260807-rbac-configurable-design-and-tasks.md
 *
 * 这里定义系统里存在哪些权限点。数据库的 `Permission` 表只是本文件的镜像，
 * 由 `scripts/rbac/sync-permissions.ts` 在部署时同步 —— 本文件删掉的权限点，
 * 同步脚本会连带从所有角色的 `permissions[]` 上摘掉。
 *
 * ⛔ 页面上不能新建权限点。原因：权限点必须对应代码里真实存在的判定，
 *    页面上建一个代码不认的权限点毫无作用，反而制造「配了但不生效」的假象。
 *
 * ⛔ sortKey 一经分配不得重排 —— JWT 里的权限位图靠它定位。
 *    sortKey 由本文件的声明顺序自动分配，并由 `lib/rbac/sortkeys.json` 冻结。
 *    新增权限点**只能追加到所属模块的末尾**（见 tests/rbac-catalog.test.ts）。
 */

/** 权限点定义 */
export interface PermissionDef {
  /** 全局唯一 id，形如 "sales.order.create" */
  id: string
  /** 模块，形如 "sales.order" */
  module: string
  /** 动作，形如 "create" */
  action: string
  labelZh: string
  labelEn: string
  /** 位图序号，由声明顺序分配后冻结 */
  sortKey: number
}

/** 模块定义（配置页按模块分组展示权限点） */
interface ModuleDef {
  module: string
  labelZh: string
  labelEn: string
  /** 该模块支持的动作。顺序即 sortKey 顺序，只能追加 */
  actions: Array<{ action: string; labelZh: string; labelEn: string }>
  /** 该模块的说明，配置页上显示给管理员看 */
  note?: string
}

/** 模块组（配置页的一级分组） */
interface GroupDef {
  key: string
  labelZh: string
  labelEn: string
  modules: ModuleDef[]
}

// ── 常用动作的复用定义 ──────────────────────────────────────────────────────
const A = {
  read: { action: 'read', labelZh: '查看', labelEn: 'View' },
  create: { action: 'create', labelZh: '新建', labelEn: 'Create' },
  update: { action: 'update', labelZh: '修改', labelEn: 'Edit' },
  delete: { action: 'delete', labelZh: '删除', labelEn: 'Delete' },
  confirm: { action: 'confirm', labelZh: '确认', labelEn: 'Confirm' },
  cancel: { action: 'cancel', labelZh: '取消', labelEn: 'Cancel' },
  manage: { action: 'manage', labelZh: '管理', labelEn: 'Manage' },
  access: { action: 'access', labelZh: '进入', labelEn: 'Access' },
} as const

export const PERMISSION_GROUPS: GroupDef[] = [
  {
    key: 'sales',
    labelZh: '销售',
    labelEn: 'Sales',
    modules: [
      {
        module: 'sales.order',
        labelZh: '销售订单',
        labelEn: 'Sales Order',
        actions: [A.read, A.create, A.update, A.delete, A.confirm, A.cancel],
      },
      {
        module: 'sales.quotation',
        labelZh: '报价单',
        labelEn: 'Quotation',
        note: '报价单没有独立 API，与销售订单共用 /api/orders。此权限点只作用于页面与按钮显隐。',
        actions: [A.access],
      },
      {
        module: 'sales.daily_report',
        labelZh: '当日销售汇总',
        labelEn: 'Daily Sales',
        actions: [A.read],
      },
      {
        module: 'sales.discrepancy',
        labelZh: '订单差异',
        labelEn: 'Order Discrepancy',
        actions: [A.read, A.manage],
      },
      {
        module: 'sales.workbench',
        labelZh: '今日工作台',
        labelEn: 'Workbench',
        actions: [A.read],
      },
    ],
  },
  {
    key: 'purchase',
    labelZh: '采购',
    labelEn: 'Purchase',
    modules: [
      {
        module: 'purchase.order',
        labelZh: '采购单',
        labelEn: 'Purchase Order',
        note: 'create 与 approve 刻意分开：办公室销售能录不能批，高级销售才能批。',
        actions: [
          A.read,
          A.create,
          A.update,
          { action: 'approve', labelZh: '审批', labelEn: 'Approve' },
          { action: 'receive', labelZh: '收货', labelEn: 'Receive' },
        ],
      },
      {
        module: 'purchase.suggestion',
        labelZh: '采购建议',
        labelEn: 'Purchase Suggestion',
        actions: [A.read, A.manage],
      },
      {
        module: 'purchase.plan',
        labelZh: '年度采购计划',
        labelEn: 'Annual Plan',
        actions: [A.read, A.manage],
      },
    ],
  },
  {
    key: 'stock',
    labelZh: '库存',
    labelEn: 'Inventory',
    modules: [
      {
        module: 'stock.receipt',
        labelZh: '收货卸货',
        labelEn: 'Goods Receipt',
        actions: [A.read, A.create, A.confirm],
      },
      {
        module: 'stock.quality',
        labelZh: '质量检查',
        labelEn: 'Quality Check',
        actions: [A.read, A.manage],
      },
      {
        module: 'stock.pick',
        labelZh: '配货出库',
        labelEn: 'Picking',
        actions: [A.read, A.manage],
      },
      {
        module: 'stock.move',
        labelZh: '库存流水',
        labelEn: 'Stock Move',
        actions: [A.read, A.create],
      },
      {
        module: 'stock.take',
        labelZh: '库存盘点',
        labelEn: 'Stock Take',
        actions: [A.read, A.create, A.update],
      },
      {
        module: 'stock.lot',
        labelZh: '批次效期',
        labelEn: 'Lot',
        actions: [A.read, A.manage],
      },
      {
        module: 'stock.zone',
        labelZh: '库区',
        labelEn: 'Zone',
        actions: [A.read, A.manage],
      },
      {
        module: 'stock.scrap',
        labelZh: '报损',
        labelEn: 'Scrap',
        actions: [A.read, A.manage],
      },
    ],
  },
  {
    key: 'dispatch',
    labelZh: '配送',
    labelEn: 'Dispatch',
    modules: [
      {
        module: 'dispatch.console',
        labelZh: '配送中心',
        labelEn: 'Dispatch Console',
        note: '独立权限点，可通过「个人级例外」单独发给特定办公室销售。',
        actions: [A.access],
      },
      {
        module: 'dispatch.wave',
        labelZh: '波次',
        labelEn: 'Wave',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'dispatch.trip',
        labelZh: '行程',
        labelEn: 'Trip',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'dispatch.driver_slot',
        labelZh: '司机配置',
        labelEn: 'Driver Slot',
        actions: [A.read, A.manage],
      },
      {
        module: 'dispatch.batch_analysis',
        labelZh: '批次分析',
        labelEn: 'Batch Analysis',
        actions: [A.read],
      },
    ],
  },
  {
    key: 'finance',
    labelZh: '财务',
    labelEn: 'Finance',
    modules: [
      {
        module: 'finance.invoice',
        labelZh: '发票',
        labelEn: 'Invoice',
        actions: [
          A.read,
          A.create,
          A.update,
          A.delete,
          { action: 'pay', labelZh: '收款', labelEn: 'Pay' },
          A.cancel,
        ],
      },
      {
        module: 'finance.payment',
        labelZh: '收付款',
        labelEn: 'Payment',
        actions: [A.read, A.create],
      },
      {
        module: 'finance.statement',
        labelZh: '对账单',
        labelEn: 'Statement',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'finance.credit_note',
        labelZh: '退款单',
        labelEn: 'Credit Note',
        actions: [A.read, A.create],
      },
      {
        module: 'finance.vendor_bill',
        labelZh: '供应商账单',
        labelEn: 'Vendor Bill',
        actions: [A.read, A.create, A.update, { action: 'pay', labelZh: '付款', labelEn: 'Pay' }],
      },
      {
        module: 'finance.account',
        labelZh: '会计科目与账务',
        labelEn: 'Accounting',
        actions: [A.read, A.manage],
      },
      {
        module: 'finance.settlement',
        labelZh: '司机交账',
        labelEn: 'Driver Settlement',
        note: 'DRIVER 提交交账用 create；FINANCE 确认/退回用 confirm。',
        actions: [A.read, A.create, A.confirm],
      },
    ],
  },
  {
    key: 'master',
    labelZh: '基础档案',
    labelEn: 'Master Data',
    modules: [
      {
        module: 'master.customer',
        labelZh: '客户',
        labelEn: 'Customer',
        actions: [
          A.read,
          A.create,
          A.update,
          A.delete,
          { action: 'export_gdpr', labelZh: 'GDPR 导出', labelEn: 'GDPR Export' },
          { action: 'delete_gdpr', labelZh: 'GDPR 删除', labelEn: 'GDPR Erase' },
        ],
      },
      {
        module: 'master.product',
        labelZh: '商品',
        labelEn: 'Product',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'master.pricelist',
        labelZh: '价格表',
        labelEn: 'Pricelist',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'master.supplier',
        labelZh: '供应商',
        labelEn: 'Supplier',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'master.uom',
        labelZh: '计量单位',
        labelEn: 'Unit of Measure',
        actions: [A.read, A.create, A.update],
      },
    ],
  },
  {
    key: 'analytics',
    labelZh: '数据分析',
    labelEn: 'Analytics',
    modules: [
      { module: 'analytics.sales', labelZh: '销售分析', labelEn: 'Sales Analytics', actions: [A.read] },
      { module: 'analytics.purchase', labelZh: '采购分析', labelEn: 'Purchase Analytics', actions: [A.read] },
      { module: 'analytics.margin', labelZh: '毛利分析', labelEn: 'Margin Analytics', actions: [A.read] },
      { module: 'analytics.logistics', labelZh: '物流分析', labelEn: 'Logistics Analytics', actions: [A.read] },
      { module: 'analytics.finance', labelZh: '财务分析', labelEn: 'Finance Analytics', actions: [A.read] },
      { module: 'analytics.inventory', labelZh: '库存分析', labelEn: 'Inventory Analytics', actions: [A.read] },
      {
        module: 'analytics.commission',
        labelZh: '司机提成考核',
        labelEn: 'Driver Commission',
        actions: [A.read],
      },
      { module: 'analytics.report', labelZh: '通用报表', labelEn: 'Reports', actions: [A.read] },
    ],
  },
  {
    key: 'print',
    labelZh: '打印',
    labelEn: 'Print',
    modules: [
      {
        module: 'print.center',
        labelZh: '打印中心',
        labelEn: 'Print Center',
        note: '独立权限点，可通过「个人级例外」单独发给特定办公室销售。',
        actions: [A.access],
      },
    ],
  },
  {
    key: 'portal',
    labelZh: '客户门户',
    labelEn: 'Customer Portal',
    modules: [
      {
        module: 'portal.self',
        labelZh: '客户自助下单',
        labelEn: 'Self Service',
        note: '客户门户三个路由已按 customerId 行级隔离，且不回 standardPrice / commissionPrice。',
        actions: [A.access],
      },
    ],
  },
  {
    key: 'tool',
    labelZh: '通用工具',
    labelEn: 'Tools',
    modules: [
      {
        module: 'tool.geo',
        labelZh: '地理编码与路径',
        labelEn: 'Geocoding',
        actions: [{ action: 'use', labelZh: '使用', labelEn: 'Use' }],
      },
      {
        module: 'tool.upload',
        labelZh: '文件上传',
        labelEn: 'Upload',
        actions: [{ action: 'use', labelZh: '使用', labelEn: 'Use' }],
      },
      {
        module: 'tool.fx',
        labelZh: '汇率',
        labelEn: 'FX Rate',
        actions: [A.read],
      },
    ],
  },
  {
    key: 'system',
    labelZh: '系统管理',
    labelEn: 'System',
    modules: [
      {
        module: 'system.user',
        labelZh: '用户账号',
        labelEn: 'User',
        actions: [A.read, A.manage],
      },
      {
        module: 'system.rbac',
        labelZh: '角色与权限',
        labelEn: 'Roles & Permissions',
        note: '⛔ 拥有此权限即可修改任何人的权限。系统始终至少保留一个拥有它的活跃账号。',
        actions: [A.read, A.manage],
      },
      {
        module: 'system.backup',
        labelZh: '备份',
        labelEn: 'Backup',
        actions: [A.read, A.manage],
      },
      {
        module: 'system.audit',
        labelZh: '操作日志',
        labelEn: 'Audit Log',
        actions: [A.read],
      },
      {
        module: 'system.gdpr',
        labelZh: 'GDPR 数据请求',
        labelEn: 'GDPR Requests',
        actions: [A.manage],
      },
      {
        module: 'system.settings',
        labelZh: '系统设置',
        labelEn: 'Settings',
        actions: [A.read, A.manage],
      },
    ],
  },
]

/**
 * 展开成扁平权限点列表，sortKey 按声明顺序分配。
 * ⛔ 顺序即位图序号 —— 只能往模块末尾追加，不能插队、不能重排。
 */
export const PERMISSIONS: readonly PermissionDef[] = PERMISSION_GROUPS.flatMap((g) =>
  g.modules.flatMap((m) =>
    m.actions.map((a) => ({
      id: `${m.module}.${a.action}`,
      module: m.module,
      action: a.action,
      labelZh: `${m.labelZh} — ${a.labelZh}`,
      labelEn: `${m.labelEn} — ${a.labelEn}`,
      sortKey: -1, // 占位，下面统一赋值
    })),
  ),
).map((p, i) => ({ ...p, sortKey: i }))

/** 权限点总数 —— 位图长度 = ceil(TOTAL / 8) 字节 */
export const PERMISSION_COUNT = PERMISSIONS.length

/** id → 定义 */
export const PERMISSION_BY_ID: ReadonlyMap<string, PermissionDef> = new Map(
  PERMISSIONS.map((p) => [p.id, p]),
)

/** id → sortKey，位图编解码用 */
export const SORT_KEY_BY_ID: ReadonlyMap<string, number> = new Map(
  PERMISSIONS.map((p) => [p.id, p.sortKey]),
)

/** 全部合法权限点 id */
export type PermissionId = string

/** 判断一个 id 是否是当前 catalog 里存在的权限点 */
export function isKnownPermission(id: string): boolean {
  return PERMISSION_BY_ID.has(id)
}

/** 展开模块通配：'sales.order.*' → 该模块全部权限点 id */
export function expandPermissionPattern(pattern: string): string[] {
  if (!pattern.endsWith('.*')) return isKnownPermission(pattern) ? [pattern] : []
  const modulePrefix = pattern.slice(0, -2)
  return PERMISSIONS.filter((p) => p.module === modulePrefix).map((p) => p.id)
}
