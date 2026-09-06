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
 * ⛔ sortKey 一经分配不得改变 —— JWT 里的权限位图靠它定位，序号错位 = 用户凭空
 *    拿到别人的权限，且不报任何错。所以 **sortKey 的权威来源是
 *    `lib/rbac/sortkeys.json`，不是本文件的声明顺序**：
 *      - 已存在的权限点：永远用快照里那个号
 *      - 新增的权限点：由 `scripts/rbac/sync-sortkeys.ts` 分配 max+1
 *    因此本文件里的顺序可以随意调整、可以往任何模块中间插动作，都不会影响位图。
 *    唯一要求是：加了权限点就要跑一次 sync 脚本（漏跑的话测试会红）。
 */

import sortkeys from './sortkeys.json'

/** 冻结的位图序号表 —— 权威来源，见文件头说明 */
const FROZEN_SORT_KEYS: Record<string, number> = sortkeys.keys

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
        note: '细分动作是从现网可达性反推出来的：单张下单与批量导入、改内容与改派波次、'
          + '看订单与看修改审计，现实中就分属不同岗位。',
        actions: [
          A.read, A.create, A.update, A.delete, A.confirm, A.cancel,
          { action: 'bulk_import', labelZh: '批量导入', labelEn: 'Bulk Import' },
          { action: 'assign_batch', labelZh: '改派波次', labelEn: 'Assign Batch' },
          { action: 'mark_printed', labelZh: '标记已打印', labelEn: 'Mark Printed' },
          { action: 'print', labelZh: '打印单据', labelEn: 'Print' },
          { action: 'dispatch_print', labelZh: '取配送打印数据', labelEn: 'Dispatch Print Data' },
          { action: 'read_audit', labelZh: '查看修改记录', labelEn: 'View Audit' },
          { action: 'write_audit', labelZh: '记录修改', labelEn: 'Write Audit' },
          { action: 'export', labelZh: '导出 CSV', labelEn: 'Export CSV' },
          { action: 'delete_line', labelZh: '删除订单行', labelEn: 'Delete Line' },
          // 台账 X1/X2：从 update 里拆出来的子动作。没有它，改价会按价格表价入库
          // （不是报错，是安静地换掉你填的数）——所以它必须发给原本就能改单的角色，
          // 否则等于把一个一直存在的能力对全公司静默关掉
          { action: 'override_price', labelZh: '手动改价', labelEn: 'Override Price' },
        ],
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
        note: 'manage 用于「缺货一键改量」这类从汇总页发起的批量写入。',
        actions: [A.read, A.manage],
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
          { action: 'print', labelZh: '打印', labelEn: 'Print' },
        ],
      },
      {
        module: 'purchase.legacy',
        labelZh: '进货单（旧模块）',
        labelEn: 'Legacy Purchase',
        note: '/api/purchases 与 /api/purchase-orders 是两套并存的采购模块，权限也分开。',
        actions: [A.read, A.create, A.delete],
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
        actions: [
          A.read, A.manage,
          { action: 'read_pallets', labelZh: '查看托盘', labelEn: 'View Pallets' },
          { action: 'manage_pallets', labelZh: '维护托盘', labelEn: 'Manage Pallets' },
        ],
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
        actions: [
          A.read,
          { action: 'read_detail', labelZh: '查看波次详情', labelEn: 'View Detail' },
          A.create, A.update, A.delete,
          { action: 'print_log', labelZh: '记录打印', labelEn: 'Print Log' },
        ],
      },
      {
        module: 'dispatch.trip',
        labelZh: '行程',
        labelEn: 'Trip',
        actions: [
          A.read, A.create, A.update, A.delete,
          { action: 'print', labelZh: '打印面单', labelEn: 'Print' },
          { action: 'read_verify', labelZh: '查看核货', labelEn: 'View Verify' },
          { action: 'verify', labelZh: '核货', labelEn: 'Verify' },
          { action: 'read_returns', labelZh: '查看退货', labelEn: 'View Returns' },
          { action: 'returns', labelZh: '退货处理', labelEn: 'Returns' },
          { action: 'read_discrepancy', labelZh: '查看差异', labelEn: 'View Discrepancy' },
          { action: 'discrepancy', labelZh: '差异处理', labelEn: 'Discrepancy' },
          { action: 'correct_signature', labelZh: '更正签收', labelEn: 'Correct Signature' },
        ],
      },
      {
        module: 'dispatch.driver_slot',
        labelZh: '司机配置',
        labelEn: 'Driver Slot',
        actions: [A.read, A.manage],
      },
      {
        module: 'dispatch.driver_summary',
        labelZh: '司机汇总',
        labelEn: 'Driver Summary',
        actions: [A.read],
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
        actions: [A.read, A.create, A.update, A.delete],
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
          { action: 'read_detail', labelZh: '查看客户详情', labelEn: 'View Detail' },
          { action: 'read_credit', labelZh: '查看信用与账期', labelEn: 'View Credit' },
          { action: 'extend_term', labelZh: '延长账期', labelEn: 'Extend Payment Term' },
          { action: 'read_last_prices', labelZh: '查看历史成交价', labelEn: 'View Last Prices' },
          { action: 'bulk_import', labelZh: '批量导入', labelEn: 'Bulk Import' },
        ],
      },
      {
        module: 'master.product',
        labelZh: '商品',
        labelEn: 'Product',
        note: 'read 是商品列表，read_detail 是单个商品档案 —— 配送岗只需要前者。',
        actions: [
          A.read,
          { action: 'read_detail', labelZh: '查看商品详情', labelEn: 'View Detail' },
          { action: 'read_price_history', labelZh: '查看价格历史', labelEn: 'View Price History' },
          A.create, A.update, A.delete,
        ],
      },
      {
        module: 'master.pricelist',
        labelZh: '价格表',
        labelEn: 'Pricelist',
        actions: [
          A.read, A.create, A.update, A.delete,
          { action: 'print', labelZh: '打印价格表', labelEn: 'Print' },
        ],
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
      {
        module: 'master.uom_category',
        labelZh: '单位分类',
        labelEn: 'UoM Category',
        actions: [A.read, A.create],
      },
      {
        module: 'master.product_template',
        labelZh: '商品模板',
        labelEn: 'Product Template',
        actions: [A.read, A.create, A.update, A.delete],
      },
      {
        module: 'master.product_category',
        labelZh: '商品分类',
        labelEn: 'Product Category',
        actions: [A.read, A.create, A.update, A.delete],
      },
    ],
  },
  {
    key: 'analytics',
    labelZh: '数据分析',
    labelEn: 'Analytics',
    modules: [
      { module: 'analytics.sales', labelZh: '销售分析', labelEn: 'Sales Analytics', actions: [A.read] },
      { module: 'analytics.purchase', labelZh: '采购分析（总览）', labelEn: 'Purchase Overview', actions: [A.read] },
      { module: 'analytics.purchase_detail', labelZh: '采购分析（明细）', labelEn: 'Purchase Detail', actions: [A.read] },
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
      {
        module: 'analytics.report',
        labelZh: '通用报表与快照',
        labelEn: 'Reports & Snapshots',
        note: 'manage 用于生成分析快照（写入 Snapshot 表）；generate 用于按需跑通用报表。',
        actions: [A.read, A.manage, { action: 'generate', labelZh: '生成报表', labelEn: 'Generate' }],
      },
      {
        module: 'analytics.chat',
        labelZh: 'AI 问数',
        labelEn: 'AI Data Chat',
        note: '自然语言问数（Gemini 翻译成结构化查询，经确认后在生产库只读执行）。read=提问查看；manage=存为常用报表。',
        actions: [A.read, A.manage],
      },
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
      {
        module: 'tool.bulletin',
        labelZh: '信息广场',
        labelEn: 'Info Board',
        actions: [{ action: 'use', labelZh: '使用', labelEn: 'Use' }],
        note: '内部员工发帖/浏览广场；只用来把 RESTAURANT 客户门户账号挡在外面，不做角色差异化——管理动作（置顶/删任意帖）在 handler 内部另判 BOSS/OPERATOR，见 lib/bulletin.ts',
      },
    ],
  },
  {
    key: 'page',
    labelZh: '页面入口',
    labelEn: 'Page Access',
    modules: [
      { module: 'page.operator', labelZh: '运营后台', labelEn: 'Operator Console', actions: [A.access] },
      { module: 'page.boss', labelZh: '分析中心', labelEn: 'Analytics Center', actions: [A.access] },
      { module: 'page.finance', labelZh: '财务台', labelEn: 'Finance Desk', actions: [A.access] },
      { module: 'page.accounting', labelZh: '账务台', labelEn: 'Accounting Desk', actions: [A.access] },
      { module: 'page.warehouse', labelZh: '仓库台', labelEn: 'Warehouse Desk', actions: [A.access] },
      { module: 'page.sorter', labelZh: '分拣台', labelEn: 'Sorting Desk', actions: [A.access] },
      { module: 'page.driver', labelZh: '司机端', labelEn: 'Driver App', actions: [A.access] },
      { module: 'page.dispatch_console', labelZh: '配送中心页', labelEn: 'Dispatch Console Page', actions: [A.access] },
      { module: 'page.print', labelZh: '打印中心页', labelEn: 'Print Center Page', actions: [A.access] },
      { module: 'page.portal', labelZh: '客户门户页', labelEn: 'Customer Portal Page', actions: [A.access] },
      { module: 'page.restaurant', labelZh: '餐厅旧版页', labelEn: 'Restaurant Legacy Page', actions: [A.access] },
      { module: 'page.bulletin', labelZh: '信息广场页', labelEn: 'Info Board Page', actions: [A.access] },
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
        note: 'manage 用于清理历史日志 —— 能删审计记录的人本身就该是少数。',
        actions: [A.read, A.manage],
      },
      {
        module: 'system.gdpr',
        labelZh: 'GDPR 数据请求',
        labelEn: 'GDPR Requests',
        actions: [A.manage],
      },
      {
        module: 'system.mfa',
        labelZh: '二次验证自助绑定',
        labelEn: 'MFA Enrollment',
        note: '现网只有运营与老板够得着 —— 收窄角色的 COMMON 白名单里没有 /api/mfa。'
          + '这是现状，不是本次设计的选择；要放开就在配置页里给对应角色勾上。',
        actions: [{ action: 'enroll', labelZh: '绑定', labelEn: 'Enroll' }],
      },
      {
        module: 'system.notification',
        labelZh: '通知',
        labelEn: 'Notification',
        note: '读自己的通知无需权限；create 是往别人那里推通知，属于运营动作。',
        actions: [A.create],
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
 * 展开成扁平权限点列表。
 * sortKey 一律从 `sortkeys.json` 取 —— 声明顺序不参与，所以往任何位置插权限点都安全。
 * 快照里没有的权限点（刚加还没跑 sync）拿到 -1，由 `tests/rbac-catalog.test.ts` 拦下。
 */
export const PERMISSIONS: readonly PermissionDef[] = PERMISSION_GROUPS.flatMap((g) =>
  g.modules.flatMap((m) =>
    m.actions.map((a) => {
      const id = `${m.module}.${a.action}`
      return {
        id,
        module: m.module,
        action: a.action,
        labelZh: `${m.labelZh} — ${a.labelZh}`,
        labelEn: `${m.labelEn} — ${a.labelEn}`,
        sortKey: FROZEN_SORT_KEYS[id] ?? -1,
      }
    }),
  ),
)

/** 权限点总数 */
export const PERMISSION_COUNT = PERMISSIONS.length

/**
 * 位图长度（字节）。注意用的是 **最大 sortKey + 1** 而不是权限点数量 ——
 * 删除权限点会让序号出现空洞，空洞不能压缩（压缩就等于重排）。
 */
export const PERMISSION_BITMAP_BYTES = Math.ceil(
  (Math.max(-1, ...PERMISSIONS.map((p) => p.sortKey)) + 1) / 8,
)

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
