/**
 * 采购分析里商品的展示文本：名称 + 规格 + 描述。
 *
 * spec/description 取自 PurchaseOrderLine 的下单时快照（见 veggie_purchasing_report 视图
 * 20261015 新增的 product_spec/description 两列），不是 Product 当前值——同一商品后来改名
 * 改规格，历史报表数字不跟着变。
 */
export function productLabel(name: string, spec?: string | null, description?: string | null) {
  const extra = [spec?.trim(), description?.trim()].filter((s): s is string => !!s).join(' · ')
  return extra ? `${name} (${extra})` : name
}
