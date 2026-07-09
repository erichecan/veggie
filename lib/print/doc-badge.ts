/**
 * 打印单据左上角「单据类型徽章」——中英文彩色标识，一眼分辨这是什么单。
 * 各打印模板共用,内联样式(不依赖模板各自的 CSS class),放在页头公司名一侧/上方。
 */

export type DocKind =
  | 'picking'        // 拣货单
  | 'delivery'       // 送货单
  | 'deliverySummary'// 送货汇总单
  | 'salesOrder'     // 销售订单
  | 'invoice'        // 发票
  | 'reportDay'      // 订单汇总报表
  | 'reportMultiline'// 商品明细清单
  | 'reportSummary'  // 商品×星期汇总
  | 'pricelist'      // 价格表

const SPEC: Record<DocKind, { zh: string; en: string; color: string }> = {
  picking:         { zh: '拣货单',       en: 'PICKING LIST',      color: '#ea580c' },
  delivery:        { zh: '送货单',       en: 'DELIVERY NOTE',     color: '#2563eb' },
  deliverySummary: { zh: '送货汇总单',   en: 'DELIVERY SUMMARY',  color: '#16a34a' },
  salesOrder:      { zh: '销售订单',     en: 'SALES ORDER',       color: '#875A7B' },
  invoice:         { zh: '发票',         en: 'INVOICE',           color: '#1a3a2a' },
  reportDay:       { zh: '订单汇总报表', en: 'ORDER SUMMARY',     color: '#475569' },
  reportMultiline: { zh: '商品明细清单', en: 'PRODUCT LINES',     color: '#475569' },
  reportSummary:   { zh: '商品×星期汇总', en: 'WEEKLY SUMMARY',   color: '#475569' },
  pricelist:       { zh: '价格表',       en: 'PRICE LIST',        color: '#0d9488' },
}

/** 返回一个内联样式的徽章 HTML,放在打印页左上角。suffix 可选(如拣货单的整箱/零散)。 */
export function docBadge(kind: DocKind, suffix?: string): string {
  const { zh, en, color } = SPEC[kind]
  return `<div style="display:inline-flex;align-items:baseline;gap:6px;background:${color};color:#fff;padding:2mm 3.5mm;border-radius:3px;line-height:1.15;white-space:nowrap;">
    <span style="font-size:12pt;font-weight:bold;">${zh}</span>
    <span style="font-size:8pt;font-weight:600;letter-spacing:0.5px;opacity:0.92;">${en}</span>
    ${suffix ? `<span style="font-size:8.5pt;font-weight:600;padding-left:6px;border-left:1px solid rgba(255,255,255,0.5);">${suffix}</span>` : ''}
  </div>`
}
