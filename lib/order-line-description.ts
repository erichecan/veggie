/**
 * 订单 / 报价行 Description 的唯一取值规则。
 *
 * ⛔ Description 落库是 `OrderLine.spec` —— **行快照**，写入后不再跟随商品变化。
 * 所以「下单页新建」和「详情页编辑时加行」必须用同一套规则，否则同一张单里
 * 先加的行有值、后加的行空白，而且错误被永久固化进历史数据（2026-08-18 客户实测反馈：
 * 同一张报价单里 4 行 Tomato Beef CASE，只有创建时那行有 Description）。
 *
 * 2026-09-02：商品详情页新增的「Sale Description」字段（`Product.saleDescription`）
 * 才是现在客户往商品上填说明用的地方；旧的 `Product.spec` 合表重构后已经没人写了，
 * 只剩历史数据。取值优先用 saleDescription，兼容旧数据时才落回 spec，都没有就留空
 * ——不兜底成商品名。
 */
export function lineDescription(p: { name: string; saleDescription?: string | null; spec?: string | null }): string {
  return p.saleDescription?.trim() || p.spec?.trim() || ''
}
