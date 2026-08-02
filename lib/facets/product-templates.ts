/**
 * 商品（ProductTemplate）列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * key 与 lib/list-filters.ts 的 PRODUCT_FACET_FIELDS 一一对应（前端只需要 key+label，
 * 不能 import 本文件，因为子句里的写法是给 Prisma 用的）。
 * 语义：同一维度多值 OR，不同维度之间 AND —— 由 lib/facet-sql.ts buildFacetWhere 保证。
 * 'all' 不在此声明，它走路由已有的 search 参数。
 */
import type { FacetDef } from '../facet-sql'

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

export const PRODUCT_TEMPLATE_FACET_DEFS: FacetDef[] = [
  { key: 'name',        label: '名称',     toClause: v => ({ name: like(v) }) },
  { key: 'ref',         label: '内部编号', toClause: v => ({ internalRef: like(v) }) },
  { key: 'category',    label: '类目',     toClause: v => ({ category: { OR: [{ name: like(v) }, { nameZh: like(v) }] } }) },
  { key: 'variant',     label: '变体',     toClause: v => ({ products: { some: { name: like(v) } } }) },
  // 条码维度暂不开放：ProductTemplate.barcode 当前 0/5482 有值，放出来只会永远搜不到。
  // 等条码数据导入（合同「PDA 扫码」条款）后，把 barcode 加回这里和 PRODUCT_FACET_FIELDS 即可。
  { key: 'description', label: '描述',     toClause: v => ({ OR: [{ description: like(v) }, { saleDescription: like(v) }] }) },
]
