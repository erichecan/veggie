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
 *
 * 2026-09-05：可售单位（`ProductSaleUom.spec`）新增「按这个单位卖，客户拿到什么规格」，
 * 比商品级的 saleDescription 更具体（同一商品不同单位规格不同，如基础单位 500g/包、
 * CASE 10 包一箱共 5kg）。有配置就优先用它，没配置才落回商品级兜底——不影响没配过
 * 单位规格的存量商品。调用方在知道本行选用哪个 uomId 时把对应的 unitSpec 传进来。
 *
 * 2026-09-06：客户实测发现 unitSpec 会把 saleDescription 整个吃掉——打印模板上配了
 * 单位规格（如 CASE "10*3pc"）的商品，销售描述完全不显示。改成两者都非空时拼接
 * （unitSpec 在前、saleDescription 在后，用 " · " 分隔），谁都不覆盖谁；只有一方有值
 * 就单独显示那一方；两者都没有才落回旧的 spec 字段兼容历史数据。
 */
export function lineDescription(
  p: { name: string; saleDescription?: string | null; spec?: string | null },
  unitSpec?: string | null,
): string {
  const parts = [unitSpec?.trim(), p.saleDescription?.trim()].filter((s): s is string => !!s)
  return parts.length > 0 ? parts.join(' · ') : p.spec?.trim() || ''
}
