/**
 * 采购单列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * 语义：同一维度多值 OR，不同维度之间 AND（lib/facet-sql.ts buildFacetWhere 保证）。
 *
 * 已按 docs/20260802-facet-dimension-data-readiness.md 裁剪：
 * 剔除 sourceDocumentName(1/30, 3.3%)；PurchaseOrder.name 是 @unique 且全量填充，
 * 与 Order.code 那种"看得见搜不到"的情况不同，可放心作为单号维度。
 */
import type { FacetDef } from '../facet-sql'
import { prisma } from '../db'

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

/**
 * PurchaseOrder 只存 supplierId，没有到 Customer 的关系字段（供应商名是路由事后补的），
 * 所以按名字搜必须两步：先在 Customer 里找出匹配的 id，再收窄 supplierId。
 */
async function supplierClause(term: string): Promise<Record<string, unknown>> {
  const suppliers = await prisma.customer.findMany({
    where: { name: like(term) },
    select: { id: true },
  })
  return { supplierId: { in: suppliers.map(s => s.id) } }
}

export const PURCHASE_ORDER_FACET_DEFS: FacetDef[] = [
  // 'all' 此前根本没实现：采购列表页的搜索框把词发成了 ?search=，而 where 构造从不读它，
  // 于是「搜什么都返回全部」——比搜不到更难发现。
  { key: 'all',      label: '全部',   toClause: async v => ({ OR: [{ name: like(v) }, await supplierClause(v)] }) },
  { key: 'name',     label: '单号',   toClause: v => ({ name: like(v) }) },
  { key: 'supplier', label: '供应商', toClause: supplierClause },
  { key: 'product',  label: '商品',   toClause: v => ({ lines: { some: { productName: like(v) } } }) },
  { key: 'notes',    label: '备注',   toClause: v => ({ notes: like(v) }) },
]
