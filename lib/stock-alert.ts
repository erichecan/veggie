/**
 * 库存预警（低库存）判定口径 —— 商品列表页角标/筛选、库存管理页「需要关注」面板和
 * 按品类分组的低库存计数，三处共用这一句，不各写各的，防止同一个商品在不同页面
 * 显示的告警状态不一致。
 *
 * 口径：Product.safetyStockMin 由客户逐商品自行维护；<=0（含现网导入时的默认值 0）
 * 视为"没设置"，不参与判断——跟负库存（qtyOnHand < 0，明确异常，各处单独判断）是两件事。
 * "达到预警值"即触发：qtyOnHand <= safetyStockMin。
 */
export function lowStockSqlCondition(alias?: string): string {
  const col = (name: string) => (alias ? `${alias}."${name}"` : `"${name}"`)
  return `${col('safetyStockMin')} > 0 AND ${col('qtyOnHand')} <= ${col('safetyStockMin')}`
}
