/**
 * 赠品行的金额单元格（React 版，20260918）
 * ============================================================================
 * 口径与打印模板完全一致：赠品行的金额列印 GIFT，不印 €0.00 —— 客户在单据上
 * 分不清「送的」和「该收钱但价格填漏了」，是 20260918 那次反馈的起点。
 *
 * 打印模板（`lib/print/*-template.ts`、`lib/order-pdf.ts`）是字符串拼接，用
 * `lib/print/gift-mark.ts` 的 `giftMoneyCell()`；屏幕上的发票页是 JSX，用这个。
 * 两处必须同时改，不然同一张发票在屏幕上和打印出来长得不一样。
 */
export function GiftAmount({ isGift, value }: { isGift?: boolean; value: string }) {
  if (!isGift) return <>{value}</>
  return <span className="font-bold tracking-wide text-green-700">GIFT</span>
}
