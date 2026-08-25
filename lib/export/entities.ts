/**
 * 可导出实体的元数据 —— 权限点与文件名。
 * ============================================================================
 * ⛔ 本文件**不得** import prisma 或任何服务端专有模块：
 *    lib/rbac/route-map.ts 会 import 它来生成路由规则，而 route-map 要在
 *    middleware 里跑。一旦这里拖进 Prisma，middleware 会连带崩掉。
 *    需要查询的部分放在 lib/export/registry.ts（那个文件只在路由里被 import）。
 *
 * 权限点沿用**该列表自己的查看权限**，不为导出单开权限点（决策 D-3，
 * 见 docs/20260818-global-csv-export-design-and-tasks.md）：能翻页就能抄，
 * 导出只是效率差别；而新增权限点必须同步补给现有角色，漏一个就是功能对
 * 某些人静默失效 —— 2026-08-07 已经踩过一次。
 *
 * 例外：销售单导出早于本模块存在，仍用它自己的 sales.order.export，
 * 不动它以免已配置好的角色权限发生变化。
 */

export interface ExportEntityMeta {
  /** 导出所需权限点 = 该列表的查看权限 */
  permission: string
  /** 文件名用的实体名 */
  labelZh: string
  labelEn: string
  /**
   * 该实体列表 API 的路径。用来守住一条不变量：**能读列表的角色就能导出**。
   * 少了它，收窄型角色（WAREHOUSE / SALES / EXTERNAL_SALES 等）的旧 token
   * 会卡在 middleware 白名单上 —— 列表看得见、导出 403，且没有任何报错。
   * 见 tests/export-access-parity.test.ts
   */
  listApi: string
}

export const EXPORT_ENTITY_META = {
  'product-templates': {
    // 20260825 合表重构：ProductTemplate 已删，实体键名沿用旧名（/api/export/product-templates
    // 这个 URL 不改，避免动前端），但真实列表接口是 /api/products，要求的权限点也改成
    // 该接口实际的 master.product.read —— product_template.* 系列权限点仍保留在权限目录里
    // （决策：留作别名/技术债，不删），只是不再被任何真实路由引用。
    permission: 'master.product.read',
    labelZh: '商品',
    labelEn: 'Products',
    listApi: '/api/products',
  },
  customers: {
    permission: 'master.customer.read',
    labelZh: '客户',
    labelEn: 'Customers',
    listApi: '/api/customers',
  },
  // 报价单页与销售单列表吃的是同一个 /api/orders，导出也共用这一个实体。
  // 权限沿用列表的查看权（决策 D-3）；既有的 /api/orders/export-csv 仍用它自己的
  // sales.order.export，不动它以免已配置好的角色权限发生变化。
  'purchase-orders': {
    permission: 'purchase.order.read',
    labelZh: '采购单',
    labelEn: 'Purchase Orders',
    listApi: '/api/purchase-orders',
  },
  statements: {
    permission: 'finance.statement.read',
    labelZh: '对账单',
    labelEn: 'Statements',
    listApi: '/api/statements',
  },
  orders: {
    permission: 'sales.order.read',
    labelZh: '订单',
    labelEn: 'Orders',
    listApi: '/api/orders',
  },
} as const satisfies Record<string, ExportEntityMeta>

export type ExportEntityKey = keyof typeof EXPORT_ENTITY_META

export function exportEntityMeta(entity: string): ExportEntityMeta | undefined {
  return (EXPORT_ENTITY_META as Record<string, ExportEntityMeta>)[entity]
}

export const EXPORT_ENTITY_KEYS = Object.keys(EXPORT_ENTITY_META) as ExportEntityKey[]
