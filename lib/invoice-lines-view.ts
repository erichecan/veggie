/**
 * 发票明细行的统一读取口径（20260920）
 * ============================================================================
 * 生产库里发票行有**两种结构**混存：
 *
 * 1. `InvoiceOrderLine`（按订单）—— Odoo 20260718 一次性迁移进来的 14.8 万张历史发票，
 *    每行只有 `{orderId, orderCode, amount}`，没有商品明细。
 * 2. `InvoiceLine`（按商品明细）—— 现在线上两条开票路径写的形状。
 *
 * 之前打印页只按第 2 种渲染，裸调 `line.taxAmount.toFixed(2)`，碰上第 1 种直接
 * `Cannot read properties of undefined` → 整页 500。发票打印对历史发票是全坏的。
 *
 * 这里把两种结构归一成一个视图模型，让打印页和详情页共用同一套判型与兜底，
 * 避免两边各写一份、改一处漏一处。
 */
import { isInvoiceOrderLine, type Invoice, type InvoiceLine, type InvoiceOrderLine } from '@/lib/types'
import { sortLinesByUomSequence } from '@/lib/print/line-sort'

export interface InvoiceLineView {
  /** 左侧主文本：商品名，或按订单记时的订单号 */
  title: string
  /** 主文本下方的小字：规格，或按订单记时的说明 */
  subtitle?: string
  /** 按订单记时这些量纲不存在，一律 null —— 渲染方据此合并单元格或留空 */
  qty: number | null
  unitPrice: number | null
  taxRate: number | null
  subtotalExTax: number | null
  taxAmount: number | null
  /** 两种结构都有金额：按商品是含税小计，按订单是该订单金额 */
  amount: number
  isGift: boolean
}

/** 这张发票是不是「按订单记」的（只要有一行是，整张就按订单口径渲染） */
export function isOrderBasedInvoice(lines: Invoice['lines']): boolean {
  return lines.length > 0 && lines.every(isInvoiceOrderLine)
}

function viewOfOrderLine(line: InvoiceOrderLine, isEn: boolean): InvoiceLineView {
  return {
    title: line.orderCode || line.orderId,
    subtitle: isEn ? 'Sales order' : '销售订单',
    qty: null,
    unitPrice: null,
    taxRate: null,
    subtotalExTax: null,
    taxAmount: null,
    amount: Number(line.amount ?? 0),
    isGift: false,
  }
}

function viewOfProductLine(line: InvoiceLine): InvoiceLineView {
  // 老数据里个别字段可能缺失，这里统一兜底成 0，不让渲染方再裸调 toFixed
  const n = (v: unknown) => (v == null ? 0 : Number(v))
  return {
    title: line.productName ?? '',
    subtitle: line.spec || undefined,
    qty: n(line.qty),
    unitPrice: n(line.unitPrice),
    taxRate: n(line.taxRate),
    subtotalExTax: n(line.subtotalExTax),
    taxAmount: n(line.taxAmount),
    amount: n(line.subtotalIncTax),
    isGift: line.isGift ?? false,
  }
}

/**
 * 把发票行归一成视图模型。
 * 按商品明细的沿用装货顺序排序（与销售单/送货单同口径）；
 * 按订单的没有商品概念，保持发票里的原始顺序，不强行排序。
 */
export function toInvoiceLineViews(lines: Invoice['lines'], isEn: boolean): InvoiceLineView[] {
  if (isOrderBasedInvoice(lines)) {
    return (lines as InvoiceOrderLine[]).map(l => viewOfOrderLine(l, isEn))
  }
  const productLines = lines.filter((l): l is InvoiceLine => !isInvoiceOrderLine(l))
  const orderLines = lines.filter(isInvoiceOrderLine)
  return [
    ...sortLinesByUomSequence(productLines).map(viewOfProductLine),
    // 混存的极端情况（同一张发票里两种行都有）：按订单的那几行排在后面，不丢
    ...orderLines.map(l => viewOfOrderLine(l, isEn)),
  ]
}

export function formatMoney(v: number | null): string {
  return v == null ? '' : `€${v.toFixed(2)}`
}
