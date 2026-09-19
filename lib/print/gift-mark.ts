/**
 * 赠品行在打印单据上的统一呈现（20260918 客户要求）
 * ============================================================================
 * `OrderLine.isGift` 上线时（20260913）只做到了「勾了不计钱」，打印链路一处都没读它 ——
 * 客户拿到的发票上，赠品行印的是「€0.00 / 0% / €0.00」，跟一个刚好免费的普通商品
 * 长得一模一样（生产实测截图）。
 *
 * 客户拍板的形式是**价格列直接印 GIFT，不印 €0.00**：金额列本来就是客户结账时唯一会
 * 逐行核的那一列，标在那里比在商品名旁边加字更难被漏看。
 *
 * 送货单、拣货单这类没有价格列的单据没法套用同一招，退化成商品名后的 GIFT 徽标 ——
 * 仓库和司机同样需要知道这箱是送的，否则会当成客户漏付款去追。
 *
 * ⚠️ 纯字符串拼接，无 React / Prisma / i18n 运行时依赖：各 `lib/print/*-template.ts`
 * 都是同构纯函数，客户端 iframe 打印与服务端 puppeteer 渲染 PDF 两条路都要能用。
 */

/** 价格 / 金额列里代替 €0.00 的文字。各模板一律引这个常量，别各自写字面量 */
export const GIFT_MONEY_TEXT = 'GIFT'

/**
 * 金额单元格内容：赠品印 `GIFT`，其余原样印调用方格式化好的金额。
 *
 * 只接管「印什么」，不接管「算什么」—— 合计、VAT 分组仍按 subtotal 实算（赠品的
 * subtotal 本来就是 0，后端在 isGift=true 时强制归零，见 OrderLine.isGift 字段注释），
 * 所以这里换文字不会让纸面合计对不上账。
 */
export function giftMoneyCell(isGift: boolean | undefined, formatted: string): string {
  if (!isGift) return formatted
  return `<span style="color:#15803d;font-weight:bold;letter-spacing:0.5px;">${GIFT_MONEY_TEXT}</span>`
}

/**
 * 商品名后的 GIFT 徽标，给没有价格列的单据（送货单 / 拣货单）用。
 *
 * `qtySuffix` 用于拣货单那种按商品聚合的场景：同一商品在一趟车里可能一部分订单是赠品、
 * 一部分不是，主行总量是混着的，只印「GIFT」会让拣货员以为整堆都是送的。
 * 内联样式，不依赖模板各自的 CSS（同 doc-badge.ts 的做法）。
 */
export function giftBadgeHtml(qtySuffix?: string): string {
  return `<span style="display:inline-block;margin-left:4px;padding:0 1.2mm;border:1px solid #15803d;border-radius:2px;color:#15803d;font-size:7.5pt;font-weight:bold;letter-spacing:0.3px;white-space:nowrap;">${GIFT_MONEY_TEXT}${qtySuffix ? ` ×${qtySuffix}` : ''}</span>`
}
