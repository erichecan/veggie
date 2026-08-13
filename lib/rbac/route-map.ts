/**
 * 路由 → 权限点映射
 * ============================================================================
 * 取代 `lib/role-access.ts` 里「角色 → 可达 API 前缀」的写法：那种写法每加一个
 * 角色就要再写一整张白名单，而这里是每个**接口**声明一次自己要什么权限。
 *
 * 匹配规则：**从上往下第一条命中为准**，所以具体路径必须写在通配之前。
 * 没有任何规则命中的路由一律**拒绝**（不是放行）—— 新增接口忘了登记的话，
 * 表现是 403 而不是敞开。这与 role-access.ts 旧的默认放行语义相反，是有意为之。
 *
 * `permission` 的三种取值：
 *   - `string`   需要这一个权限点
 *   - `string[]` **任一即可**（OR）。一个接口可能服务多个岗位场景，
 *                例如订单列表既是销售在看，也是分拣在看
 *   - `null`     无需权限（登录即可用；是否公开由 lib/public-routes.ts 决定）
 */
import { matchesPattern, type HttpMethod } from '../role-access'

export interface RouteRule {
  pattern: string
  /** 不写表示适用于全部方法 */
  methods?: readonly HttpMethod[]
  /** 需要的权限点；数组表示任一即可；null 表示无需权限 */
  permission: string | readonly string[] | null
  /** 为什么这么定，非显而易见时写 */
  note?: string
}

const R: readonly HttpMethod[] = ['GET']
const W: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']

export const API_ROUTE_RULES: readonly RouteRule[] = [
  // ── 无需权限：登录、健康检查、自助与系统触发 ────────────────────────────
  { pattern: '/api/auth/**', permission: null },
  { pattern: '/api/health', permission: null },
  { pattern: '/api/tile', permission: null, note: '地图瓦片代理，本身就是公开路由' },
  { pattern: '/api/notifications', methods: ['POST'], permission: 'system.notification.create' },
  { pattern: '/api/notifications/**', permission: null, note: '读改自己的通知，无需权限' },
  { pattern: '/api/mfa/**', permission: 'system.mfa.enroll' },
  { pattern: '/api/cron/**', permission: null, note: '由 CRON_SECRET 把关，不走角色' },

  // ── 客户门户：外部客户唯一能碰的东西，已按 customerId 行级隔离 ──────────
  { pattern: '/api/customer-portal/**', permission: 'portal.self.access' },

  // ── 销售订单 ────────────────────────────────────────────────────────────
  {
    pattern: '/api/orders',
    methods: R,
    permission: ['sales.order.read', 'stock.quality.read', 'stock.pick.read'],
    note: '订单列表同时是分拣与拣货的取数入口，所以三个场景任一即可',
  },
  { pattern: '/api/orders', methods: ['POST'], permission: 'sales.order.create' },
  { pattern: '/api/orders/bulk', permission: 'sales.order.bulk_import' },
  { pattern: '/api/orders/export-csv', permission: 'sales.order.export' },
  { pattern: '/api/orders/last-price', permission: 'sales.order.read' },
  { pattern: '/api/orders/sales-price-history', permission: 'sales.order.read' },
  { pattern: '/api/orders/dispatch-print-data', permission: 'sales.order.dispatch_print' },
  { pattern: '/api/orders/*/pdf', permission: 'sales.order.print' },
  // 把单据发给客户。与打印同权限 —— 都是「把单据交付给客户」，
  // 只是一个走打印机一个走邮件，不为它单开权限点。
  { pattern: '/api/orders/*/send-email', permission: 'sales.order.print' },
  { pattern: '/api/orders/*/mark-printed', permission: 'sales.order.mark_printed' },
  { pattern: '/api/orders/*/batch', permission: 'sales.order.assign_batch' },
  { pattern: '/api/orders/*/audit', methods: R, permission: 'sales.order.read_audit' },
  { pattern: '/api/orders/*/audit', methods: ['POST'], permission: 'sales.order.write_audit' },
  { pattern: '/api/orders/*/lines/*', methods: ['DELETE'], permission: 'sales.order.delete_line' },
  { pattern: '/api/orders/*/lines/*', methods: ['PATCH'], permission: 'sales.order.update' },
  { pattern: '/api/orders/*/lines', methods: ['POST'], permission: 'sales.order.update' },
  { pattern: '/api/orders/*', methods: R, permission: 'sales.order.read' },
  { pattern: '/api/orders/*', methods: ['PUT'], permission: 'sales.order.update' },
  { pattern: '/api/orders/*', methods: ['DELETE'], permission: 'sales.order.delete' },

  { pattern: '/api/order-discrepancies/**', methods: R, permission: 'sales.discrepancy.read' },
  { pattern: '/api/order-discrepancies/**', methods: W, permission: 'sales.discrepancy.manage' },
  { pattern: '/api/daily-sales/**', methods: R, permission: 'sales.daily_report.read' },
  { pattern: '/api/daily-sales/**', methods: W, permission: 'sales.daily_report.manage' },
  { pattern: '/api/workbench', permission: 'sales.workbench.read' },

  // ── 采购 ────────────────────────────────────────────────────────────────
  { pattern: '/api/purchase-orders/*/pdf', permission: 'purchase.order.print' },
  { pattern: '/api/purchase-orders/receipts-by-group', permission: 'purchase.order.read' },
  { pattern: '/api/purchase-orders/last-by-group', permission: 'purchase.order.read' },
  { pattern: '/api/purchase-orders/pdf-extract', permission: 'purchase.order.create' },
  { pattern: '/api/purchase-orders/import', permission: 'purchase.order.import' },
  { pattern: '/api/purchase-orders', methods: R, permission: 'purchase.order.read' },
  { pattern: '/api/purchase-orders', methods: ['POST'], permission: 'purchase.order.create' },
  { pattern: '/api/purchase-orders/*', methods: R, permission: 'purchase.order.read' },
  // 采购退货（台账 F3 新增）：动的是库存与已收量，按「收货」权限走，
  // 与 PATCH 的 receive 动作同一把闸 —— 能收货的人才有资格把货退回去。
  // ⛔ 必须显式登记：未登记的路由在 lib/rbac/gate.ts 里是**默认拒绝**，
  // 表现为功能整个 403（本条就是这么发现的），而不是敞开。
  { pattern: '/api/purchase-orders/*/return', methods: ['POST'], permission: 'purchase.order.receive' },
  { pattern: '/api/purchase-orders/*', methods: ['PUT', 'PATCH'], permission: 'purchase.order.update' },
  { pattern: '/api/purchases', methods: R, permission: 'purchase.legacy.read' },
  { pattern: '/api/purchases', methods: ['POST'], permission: 'purchase.legacy.create' },
  { pattern: '/api/purchases/*', methods: R, permission: 'purchase.legacy.read' },
  { pattern: '/api/purchases/*', methods: ['DELETE'], permission: 'purchase.legacy.delete' },

  { pattern: '/api/purchase-suggestions/generate-annual', permission: 'purchase.plan.manage' },
  { pattern: '/api/purchase-suggestions/generate-fresh', permission: 'purchase.suggestion.manage' },
  { pattern: '/api/purchase-suggestions/convert', permission: 'purchase.suggestion.manage' },
  { pattern: '/api/purchase-suggestions/*/convert', permission: 'purchase.suggestion.manage' },
  { pattern: '/api/purchase-suggestions/**', methods: R, permission: 'purchase.suggestion.read' },
  { pattern: '/api/purchase-suggestions/**', methods: W, permission: 'purchase.suggestion.manage' },

  // ── 库存 ────────────────────────────────────────────────────────────────
  { pattern: '/api/goods-receipts/**', methods: R, permission: 'stock.receipt.read' },
  { pattern: '/api/goods-receipts/**', methods: ['POST'], permission: 'stock.receipt.create' },
  { pattern: '/api/stock-moves/**', methods: R, permission: 'stock.move.read' },
  { pattern: '/api/stock-moves/**', methods: ['POST'], permission: 'stock.move.create' },
  { pattern: '/api/stock-takes', methods: R, permission: 'stock.take.read' },
  { pattern: '/api/stock-takes', methods: ['POST'], permission: 'stock.take.create' },
  { pattern: '/api/stock-takes/*', methods: R, permission: 'stock.take.read' },
  { pattern: '/api/stock-takes/*', methods: ['PATCH'], permission: 'stock.take.update' },
  { pattern: '/api/lots/**', methods: R, permission: 'stock.lot.read' },
  { pattern: '/api/lots/**', methods: W, permission: 'stock.lot.manage' },
  { pattern: '/api/zones/**', methods: R, permission: 'stock.zone.read' },
  { pattern: '/api/zones/**', methods: W, permission: 'stock.zone.manage' },
  { pattern: '/api/scrap/**', methods: R, permission: 'stock.scrap.read' },
  { pattern: '/api/scrap/**', methods: W, permission: 'stock.scrap.manage' },

  // ── 配送 ────────────────────────────────────────────────────────────────
  { pattern: '/api/dispatch/**', permission: 'dispatch.driver_summary.read' },
  { pattern: '/api/batch-analysis', permission: 'dispatch.batch_analysis.read' },

  { pattern: '/api/waves/*/pick-sheet', permission: 'stock.pick.read' },
  { pattern: '/api/waves/*/shortage', permission: 'stock.pick.read' },
  { pattern: '/api/waves/*/pallets', methods: R, permission: 'stock.pick.read_pallets' },
  { pattern: '/api/waves/*/pallets', methods: ['PUT'], permission: 'stock.pick.manage_pallets' },
  { pattern: '/api/waves/*/pick-lock', permission: 'stock.pick.manage' },
  { pattern: '/api/waves/*/pick-unlock', permission: 'stock.pick.manage' },
  { pattern: '/api/waves/*/assign', permission: 'dispatch.wave.update' },
  { pattern: '/api/waves/*/unassign', permission: 'dispatch.wave.update' },
  { pattern: '/api/waves/*/assignment-done', permission: 'dispatch.wave.update' },
  { pattern: '/api/waves/*/complete', permission: 'dispatch.wave.update' },
  { pattern: '/api/waves/*/dispatch', permission: 'dispatch.wave.update' },
  { pattern: '/api/waves/generate-daily', permission: 'dispatch.wave.create' },
  { pattern: '/api/waves/print-log', permission: 'dispatch.wave.print_log' },
  // 打印状态查询：必须登记在下面那条 '/api/waves/*' 通配之前，否则会被当成
  // 「某个波次的详情」要 dispatch.wave.read_detail，与路由自己 require 的不一致。
  { pattern: '/api/waves/print-status', permission: 'print.center.access' },
  { pattern: '/api/waves', methods: R, permission: 'dispatch.wave.read' },
  { pattern: '/api/waves', methods: ['POST'], permission: 'dispatch.wave.create' },
  { pattern: '/api/waves/*', methods: R, permission: 'dispatch.wave.read_detail' },
  { pattern: '/api/waves/*', methods: ['PUT'], permission: ['dispatch.wave.update', 'stock.quality.manage'] },
  { pattern: '/api/waves/*', methods: ['DELETE'], permission: 'dispatch.wave.delete' },

  { pattern: '/api/trips/*/settlement', methods: R, permission: 'finance.settlement.read' },
  { pattern: '/api/trips/*/settlement', methods: ['POST'], permission: 'finance.settlement.create' },
  { pattern: '/api/trips/*/settlement', methods: ['PUT'], permission: 'finance.settlement.confirm' },
  { pattern: '/api/trips/*/verify', methods: R, permission: 'dispatch.trip.read_verify' },
  { pattern: '/api/trips/*/verify', methods: ['POST'], permission: 'dispatch.trip.verify' },
  { pattern: '/api/trips/*/returns', methods: R, permission: 'dispatch.trip.read_returns' },
  { pattern: '/api/trips/*/returns', methods: ['POST', 'PUT'], permission: 'dispatch.trip.returns' },
  { pattern: '/api/trips/*/discrepancy', methods: R, permission: 'dispatch.trip.read_discrepancy' },
  { pattern: '/api/trips/*/discrepancy', methods: ['PUT'], permission: 'dispatch.trip.discrepancy' },
  { pattern: '/api/trips/*/signature-correction', permission: 'dispatch.trip.correct_signature' },
  { pattern: '/api/trips/*/picking-pdf', permission: 'dispatch.trip.print' },
  { pattern: '/api/trips/*/summary-pdf', permission: 'dispatch.trip.print' },
  { pattern: '/api/trips/*/print-data', permission: 'dispatch.trip.print' },
  { pattern: '/api/trips', methods: R, permission: 'dispatch.trip.read' },
  { pattern: '/api/trips', methods: ['POST'], permission: 'dispatch.trip.create' },
  { pattern: '/api/trips/*', methods: R, permission: 'dispatch.trip.read' },
  { pattern: '/api/trips/*', methods: ['PUT'], permission: 'dispatch.trip.update' },
  { pattern: '/api/trips/*', methods: ['DELETE'], permission: 'dispatch.trip.delete' },

  { pattern: '/api/driver-slots', methods: R, permission: 'dispatch.driver_slot.read' },
  { pattern: '/api/driver-slots/**', methods: W, permission: 'dispatch.driver_slot.manage' },
  { pattern: '/api/driver-slots', methods: ['POST'], permission: 'dispatch.driver_slot.manage' },

  // ── 财务 ────────────────────────────────────────────────────────────────
  { pattern: '/api/invoices/*/post', permission: 'finance.invoice.pay' },
  { pattern: '/api/invoices/ar-summary', permission: 'finance.invoice.read' },
  { pattern: '/api/invoices', methods: R, permission: 'finance.invoice.read' },
  { pattern: '/api/invoices', methods: ['POST'], permission: 'finance.invoice.create' },
  { pattern: '/api/invoices/*', methods: R, permission: 'finance.invoice.read' },
  { pattern: '/api/invoices/*', methods: ['PUT'], permission: 'finance.invoice.update' },
  { pattern: '/api/invoices/*', methods: ['DELETE'], permission: 'finance.invoice.delete' },
  { pattern: '/api/payments/**', methods: R, permission: 'finance.payment.read' },
  { pattern: '/api/payments/**', methods: ['POST'], permission: 'finance.payment.create' },
  { pattern: '/api/statements', methods: R, permission: 'finance.statement.read' },
  { pattern: '/api/statements', methods: ['POST'], permission: 'finance.statement.create' },
  { pattern: '/api/statements/*', methods: R, permission: 'finance.statement.read' },
  { pattern: '/api/statements/*', methods: ['PUT'], permission: 'finance.statement.update' },
  { pattern: '/api/statements/*', methods: ['DELETE'], permission: 'finance.statement.delete' },
  { pattern: '/api/credit-notes/generate-from-returns', permission: 'finance.credit_note.create' },
  { pattern: '/api/credit-notes', methods: R, permission: 'finance.credit_note.read' },
  { pattern: '/api/credit-notes', methods: ['POST'], permission: 'finance.credit_note.create' },
  { pattern: '/api/credit-notes/*', methods: R, permission: 'finance.credit_note.read' },
  { pattern: '/api/credit-notes/*', methods: ['PUT'], permission: 'finance.credit_note.update' },
  { pattern: '/api/credit-notes/*', methods: ['DELETE'], permission: 'finance.credit_note.delete' },
  { pattern: '/api/vendor-bills/import', permission: 'finance.vendor_bill.create' },
  { pattern: '/api/vendor-bills', methods: R, permission: 'finance.vendor_bill.read' },
  { pattern: '/api/vendor-bills', methods: ['POST'], permission: 'finance.vendor_bill.create' },
  // 分批付款流水（台账 G2）。⚠️ 必须显式登记 —— 未登记的路由在 gate 里是默认拒绝，
  // 表现为整个功能 403（F3 就是这么发现的）。放在通配之前，避免被 `/api/vendor-bills/*` 吃掉
  { pattern: '/api/vendor-bills/*/payments', methods: R, permission: 'finance.vendor_bill.read' },
  { pattern: '/api/vendor-bills/*/payments', methods: ['POST'], permission: 'finance.vendor_bill.update' },
  { pattern: '/api/vendor-bills/*', methods: R, permission: 'finance.vendor_bill.read' },
  { pattern: '/api/vendor-bills/*', methods: ['PUT'], permission: 'finance.vendor_bill.update' },
  { pattern: '/api/accounts/**', methods: R, permission: 'finance.account.read' },
  { pattern: '/api/accounts/**', methods: W, permission: 'finance.account.manage' },
  { pattern: '/api/finance/**', permission: 'finance.account.read' },

  // ── 基础档案 ────────────────────────────────────────────────────────────
  { pattern: '/api/customers/coordinates', permission: ['master.customer.read', 'dispatch.trip.read'] },
  { pattern: '/api/customers/*/credit', permission: 'master.customer.read_credit' },
  { pattern: '/api/customers/*/last-prices', permission: 'master.customer.read_last_prices' },
  { pattern: '/api/customers/bulk', permission: 'master.customer.bulk_import' },
  // 联系人（多邮箱）。读跟着「客户详情」走，写跟着「编辑客户」走 —— 不单开权限点：
  // 拆细子动作而不同步补给原本够得着的角色，会让功能对全公司静默中断（20260807）。
  // ⛔ 必须排在下面的 /api/customers/* 通配之前，否则 PATCH/DELETE 会先被
  //    「改客户 / 删客户」那两条捞走，语义就错了。
  { pattern: '/api/customers/*/contacts', methods: R, permission: 'master.customer.read_detail' },
  { pattern: '/api/customers/*/contacts', methods: W, permission: 'master.customer.update' },
  { pattern: '/api/customers/*/contacts/*', permission: 'master.customer.update' },
  { pattern: '/api/customers', methods: R, permission: 'master.customer.read' },
  { pattern: '/api/customers', methods: ['POST'], permission: 'master.customer.create' },
  { pattern: '/api/customers/*', methods: R, permission: 'master.customer.read_detail' },
  { pattern: '/api/customers/*', methods: ['PUT'], permission: 'master.customer.update' },
  { pattern: '/api/customers/*', methods: ['DELETE'], permission: 'master.customer.delete' },
  { pattern: '/api/gdpr/export', permission: 'master.customer.export_gdpr' },
  { pattern: '/api/gdpr/delete', permission: 'master.customer.delete_gdpr' },

  { pattern: '/api/products/quick-create', permission: 'master.product.create' },
  { pattern: '/api/products/bulk', permission: 'master.product.update' },
  { pattern: '/api/products/forecast', permission: 'master.product.read_detail' },
  { pattern: '/api/products/pending-demand', permission: 'master.product.read_detail' },
  { pattern: '/api/products/similar', permission: 'master.product.read_detail' },
  { pattern: '/api/products/*/price-history', permission: 'master.product.read_price_history' },
  { pattern: '/api/products/*/sale-uoms', methods: R, permission: 'master.product.read_detail' },
  { pattern: '/api/products/*/sale-uoms', methods: ['PUT'], permission: 'master.product.update' },
  { pattern: '/api/products/*/zone', permission: ['master.product.update', 'stock.zone.manage'] },
  { pattern: '/api/products', methods: R, permission: 'master.product.read' },
  { pattern: '/api/products', methods: ['POST'], permission: 'master.product.create' },
  { pattern: '/api/products/*', methods: R, permission: 'master.product.read_detail' },
  { pattern: '/api/products/*', methods: ['PUT'], permission: 'master.product.update' },
  { pattern: '/api/products/*', methods: ['DELETE'], permission: 'master.product.delete' },
  { pattern: '/api/product-templates/**', methods: R, permission: 'master.product_template.read' },
  { pattern: '/api/product-templates', methods: ['POST'], permission: 'master.product_template.create' },
  { pattern: '/api/product-templates/*', methods: ['PUT'], permission: 'master.product_template.update' },
  { pattern: '/api/product-templates/*', methods: ['DELETE'], permission: 'master.product_template.delete' },
  { pattern: '/api/product-categories/**', methods: R, permission: 'master.product_category.read' },
  { pattern: '/api/product-categories', methods: ['POST'], permission: 'master.product_category.create' },
  { pattern: '/api/product-categories/*', methods: ['PUT'], permission: 'master.product_category.update' },
  { pattern: '/api/product-categories/*', methods: ['DELETE'], permission: 'master.product_category.delete' },

  { pattern: '/api/pricelists/print', permission: 'master.pricelist.print' },
  { pattern: '/api/pricelists', methods: R, permission: 'master.pricelist.read' },
  { pattern: '/api/pricelists', methods: ['POST'], permission: 'master.pricelist.create' },
  { pattern: '/api/pricelists/*', methods: R, permission: 'master.pricelist.read' },
  { pattern: '/api/pricelists/*', methods: ['PUT'], permission: 'master.pricelist.update' },
  { pattern: '/api/pricelists/*', methods: ['DELETE'], permission: 'master.pricelist.delete' },

  { pattern: '/api/suppliers/**', methods: R, permission: 'master.supplier.read' },
  { pattern: '/api/suppliers', methods: ['POST'], permission: 'master.supplier.create' },
  { pattern: '/api/uoms/**', methods: R, permission: 'master.uom.read' },
  { pattern: '/api/uoms', methods: ['POST'], permission: 'master.uom.create' },
  { pattern: '/api/uoms/*', methods: ['PUT', 'DELETE'], permission: 'master.uom.update' },
  { pattern: '/api/uom-categories/**', methods: R, permission: 'master.uom_category.read' },
  { pattern: '/api/uom-categories', methods: ['POST'], permission: 'master.uom_category.create' },

  // ── 分析 ────────────────────────────────────────────────────────────────
  { pattern: '/api/analytics/sales-overview', permission: 'analytics.sales.read' },
  { pattern: '/api/analytics/customers', permission: 'analytics.sales.read' },
  { pattern: '/api/analytics/overview', permission: 'analytics.sales.read' },
  { pattern: '/api/analytics/margin', permission: 'analytics.margin.read' },
  { pattern: '/api/analytics/price-trends', permission: 'analytics.margin.read' },
  { pattern: '/api/analytics/procurement', permission: 'analytics.purchase_detail.read' },
  { pattern: '/api/analytics/procurement-overview', permission: 'analytics.purchase.read' },
  { pattern: '/api/analytics/logistics', permission: 'analytics.logistics.read' },
  // H3：这条规则让 analytics.commission.read 从「假开关」变成真闸门 ——
  // 它此前在权限目录里挂了一个月，没有任何 handler 引用（I2 查出的 13 个之一）。
  { pattern: '/api/analytics/driver-commission', permission: 'analytics.commission.read' },
  { pattern: '/api/analytics/ap-aging', permission: 'analytics.finance.read' },
  { pattern: '/api/analytics/ar-aging', permission: 'analytics.finance.read' },
  { pattern: '/api/analytics/internal-control', permission: 'analytics.finance.read' },
  { pattern: '/api/analytics/inventory-overview', permission: 'analytics.inventory.read' },
  { pattern: '/api/analytics/zone-inventory', permission: 'analytics.inventory.read' },
  { pattern: '/api/analytics/loss-dashboard', permission: 'analytics.inventory.read' },
  { pattern: '/api/analytics/shortage', permission: 'analytics.inventory.read' },
  { pattern: '/api/analytics/snapshots', methods: R, permission: 'analytics.report.read' },
  { pattern: '/api/analytics/snapshots', methods: ['POST'], permission: 'analytics.report.manage' },
  { pattern: '/api/reports/*/metadata', permission: 'analytics.report.read' },
  { pattern: '/api/reports/**', methods: ['POST'], permission: 'analytics.report.generate' },
  { pattern: '/api/reports/**', permission: 'analytics.report.read' },

  // ── 打印 ────────────────────────────────────────────────────────────────
  { pattern: '/api/print/**', permission: 'print.center.access' },

  // ── 通用工具 ────────────────────────────────────────────────────────────
  { pattern: '/api/geocode', permission: 'tool.geo.use' },
  { pattern: '/api/distance-matrix', permission: 'tool.geo.use' },
  { pattern: '/api/upload-image', permission: 'tool.upload.use' },
  { pattern: '/api/fx-rate', permission: 'tool.fx.read' },

  // ── 权限管理（配置页自己用的接口）──────────────────────────────────────
  { pattern: '/api/rbac/**', methods: R, permission: 'system.rbac.read' },
  { pattern: '/api/rbac/**', methods: W, permission: 'system.rbac.manage' },

  // ── 系统 ────────────────────────────────────────────────────────────────
  { pattern: '/api/users/*/reset-password', permission: 'system.user.manage' },
  { pattern: '/api/users', methods: R, permission: 'system.user.read' },
  { pattern: '/api/users/**', methods: W, permission: 'system.user.manage' },
  { pattern: '/api/action-logs/cleanup', permission: 'system.audit.manage' },
  { pattern: '/api/action-logs/**', permission: 'system.audit.read' },
  { pattern: '/api/backups/**', methods: R, permission: 'system.backup.read' },
  { pattern: '/api/backups/**', methods: W, permission: 'system.backup.manage' },
  { pattern: '/api/demo/**', permission: 'system.settings.manage' },
]

/**
 * 页面前缀 → 权限点。与 API 一样第一命中，未命中一律拒绝。
 *
 * ⛔ 页面用**独立的 `page.*` 权限点**，不复用 API 的。原因：页面收窄
 * （原 ROLE_PAGE_SCOPE）与 API 收窄（原 ROLE_API_SCOPE）是两套独立定义，
 * 存在大量「能调接口但进不去页面」和反过来的组合 —— 例如财务能读订单接口，
 * 却进不去运营后台页面。共用一个权限点就表达不了这种差异。
 */
export const PAGE_ROUTE_RULES: readonly RouteRule[] = [
  { pattern: '/enter', permission: null },
  // 改密页：任何登录用户都要进得来。被强制改密的账号除了这里哪都去不了，
  // 少这条规则就是「让人去改密码，却把改密码的门也锁上」（兜底语义是未命中即拒绝）
  { pattern: '/change-password', permission: null },
  { pattern: '/customer-portal/**', permission: 'page.portal.access' },
  { pattern: '/classic/restaurant/**', permission: 'page.restaurant.access' },
  { pattern: '/classic/driver/**', permission: 'page.driver.access' },
  { pattern: '/classic/sorter/**', permission: 'page.sorter.access' },
  { pattern: '/classic/warehouse/**', permission: 'page.warehouse.access' },
  { pattern: '/classic/finance/**', permission: 'page.finance.access' },
  { pattern: '/classic/accounting/**', permission: 'page.accounting.access' },
  { pattern: '/classic/print/**', permission: 'page.print.access' },
  { pattern: '/classic/operator/dispatch-console/**', permission: 'page.dispatch_console.access' },
  { pattern: '/classic/operator/**', permission: 'page.operator.access' },
  { pattern: '/classic/boss/**', permission: 'page.boss.access' },
]

/** 找出某个路由+方法所需的权限点。返回 null 表示无需权限；undefined 表示没有规则命中。 */
export function requiredPermissionsFor(
  rules: readonly RouteRule[],
  pathname: string,
  method: string,
): readonly string[] | null | undefined {
  for (const rule of rules) {
    if (rule.methods && !rule.methods.includes(method as HttpMethod)) continue
    if (!matchesPattern(rule.pattern, pathname)) continue
    if (rule.permission === null) return null
    return typeof rule.permission === 'string' ? [rule.permission] : rule.permission
  }
  return undefined
}
