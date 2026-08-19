/**
 * 订单 / 报价行 Description 的唯一取值规则。
 *
 * ⛔ Description 落库是 `OrderLine.spec` —— **行快照**，写入后不再跟随商品变化。
 * 所以「下单页新建」和「详情页编辑时加行」必须用同一套规则，否则同一张单里
 * 先加的行有值、后加的行空白，而且错误被永久固化进历史数据（2026-08-18 客户实测反馈：
 * 同一张报价单里 4 行 Tomato Beef CASE，只有创建时那行有 Description）。
 *
 * 兜底成商品名是有意为之：生产库 5477 个商品里 3970 个（72.5%）spec 为空，
 * 不兜底的话这一列对绝大多数商品都是空白。
 *
 * 用 `||` 而不是 `??`：spec 存成空串的商品同样要兜底，`??` 只挡 null/undefined。
 */
export function lineDescription(p: { name: string; spec?: string | null }): string {
  return p.spec?.trim() || p.name
}
