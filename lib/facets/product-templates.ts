/**
 * 商品（ProductTemplate）列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * key 与 lib/list-filters.ts 的 PRODUCT_FACET_FIELDS 一一对应（前端只需要 key+label，
 * 不能 import 本文件，因为子句里的写法是给 Prisma 用的）。
 * 语义：同一维度多值 OR，不同维度之间 AND —— 由 lib/facet-sql.ts buildFacetWhere 保证。
 * 'all'（下拉里的「全部」）也是一条普通维度，只是参数名沿用历史的 search（见 facetParamName）。
 */
import type { FacetDef } from '../facet-sql'

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

export const PRODUCT_TEMPLATE_FACET_DEFS: FacetDef[] = [
  // ⛔ 20260825 补 description/saleDescription：很多商品的中文名只写在描述里
  // （name 是英文 Odoo 主名），"全部"之前只看 name/internalRef，中文用户搜中文名
  // 直接落空，还得手动切到「描述」维度再搜一次——而"全部"跟"描述"是不同维度，
  // 两个 chip 叠一起是 AND 不是 OR，反而比只搜一次更搜不到。
  { key: 'all',         label: '全部',     toClause: v => ({ OR: [{ name: like(v) }, { internalRef: like(v) }, { description: like(v) }, { saleDescription: like(v) }] }) },
  { key: 'name',        label: '名称',     toClause: v => ({ name: like(v) }) },
  { key: 'ref',         label: '内部编号', toClause: v => ({ internalRef: like(v) }) },
  { key: 'category',    label: '类目',     toClause: v => ({ category: { OR: [{ name: like(v) }, { nameZh: like(v) }] } }) },
  // 20260825 合表重构：'variant' 维度删除——原本靠 `products: { some: {...} } }` 关系
  // 查"模板下有没有叫这个名字的变体"，ProductTemplate 已删，Product 自己没有子变体关系，
  // 这条查询会直接报 Prisma 未知字段错误；且这个 key 从没在 PRODUCT_FACET_FIELDS 里
  // 暴露给前端过，删掉不影响任何现有 UI。
  // 条码维度暂不开放：Product.barcode 当前 0/5482 有值，放出来只会永远搜不到。
  // 等条码数据导入（合同「PDA 扫码」条款）后，把 barcode 加回这里和 PRODUCT_FACET_FIELDS 即可。
  { key: 'description', label: '描述',     toClause: v => ({ OR: [{ description: like(v) }, { saleDescription: like(v) }] }) },
]
