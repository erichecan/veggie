import { barcodeValue } from './barcode'
import { formatDateOnly } from './format-date'
import { eur } from './format-money'
import { sortLinesBySequence } from '@/lib/print/line-sort'

/**
 * 销售单 / 报价单的单据 HTML。
 *
 * 从 `app/api/orders/[id]/pdf/route.ts` 抽出来，因为发邮件要拿同一份单据当 PDF 附件。
 * 留在 route 里的话，邮件那边只能复制一份模板，两份日后必然各改各的 ——
 * 客户打印出来的和收到邮件的对不上，是最难查的那种"数据不一致"。
 *
 * ⚠️ 这是**纯函数**：不查库、不读时间。数据获取（含 wave 派生的司机归属）留在调用方，
 * 这样它可测、可在任何上下文复用。
 *
 * ⚠️ 条码依赖 CDN 上的 JsBarcode + 客户端 JS 执行。浏览器打印没问题；
 * 走 puppeteer 渲染 PDF 时靠 `setContent(waitUntil:'load')` 等它加载。
 * 服务器不通外网的话条码会是空白（其余内容正常）—— 见 lib/print/render-pdf.ts。
 */

/** 宽松输入类型：沿用原 route 的字段读法，不强绑 Prisma 生成类型 */
export interface OrderDocLine {
  productName: string
  /**
   * 商品的 sequence，由调用方用 lib/print/product-sequence.ts 的 withProductSequence()
   * 附上。不附也不会报错，但那样整单会退化成"按商品名排" —— 别忘了附。
   */
  productSequence?: number | null
  orderedQty: unknown
  unitPrice: unknown
  subtotal: unknown
  taxRate?: unknown
  spec?: string | null
  note?: string | null
  uomName?: string | null
}

export interface OrderDocInput {
  id: string
  code?: string | null
  restaurantName: string
  quotationDate?: unknown
  deliveryDate?: unknown
  internalNote?: string | null
  lines?: OrderDocLine[] | null
  salesUser?: { name: string } | null
}

export interface OrderDocCustomer {
  street?: string | null
  address?: string | null
  street2?: string | null
  city?: string | null
  zip?: string | null
}

/**
 * VAT 税率的显示格式。
 *
 * 原来行级用 `taxRate.toFixed(0)`，把 13.5% 显示成 **14%**，而同一张发票的汇总行
 * 用的是完整精度「VAT 13.50%」—— 客户在一张单据上看到两个税率。爱尔兰的
 * 13.5% 和 4.8% 都带小数，整数化必错。
 * 整数税率（23%）不显示多余的小数位。
 */
export function formatVatRate(rate: number): string {
  return (Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(2).replace(/0$/, '')) + '%'
}

export function renderOrderHtml(
  order: OrderDocInput,
  customer: OrderDocCustomer | null,
  /** 司机归属。SSOT 是所属 wave 派生的结果，调用方负责算好传进来 */
  deliveryBatch: string,
): string {
  // 按商品 sequence 排（客户要求，2026-08-18）。以前是按 OrderLine.sequence，
  // 而实测 77.5% 的多行订单那个字段所有行都相同 —— 等于没排序，顺序由数据库
  // 返回顺序决定，同一张单两次打印都可能不一样。规则见 lib/print/line-sort.ts
  const lines = sortLinesBySequence(order.lines ?? [])

  // Compute totals
  const subtotal = lines.reduce((s, l) => s + Number(l.subtotal), 0)

  // Group VAT
  const vatGroups: Record<string, { base: number; vat: number }> = {}
  for (const l of lines) {
    const rate = Number(l.taxRate ?? 0)
    const key = rate.toFixed(1)
    const base = Number(l.subtotal)
    const vatAmt = base * (rate / 100)
    if (!vatGroups[key]) vatGroups[key] = { base: 0, vat: 0 }
    vatGroups[key].base += base
    vatGroups[key].vat += vatAmt
  }
  const totalVat = Object.values(vatGroups).reduce((s, g) => s + g.vat, 0)
  const total = subtotal + totalVat

  const orderCode = order.code ?? order.id.slice(-8).toUpperCase()

  const customerAddr = [
    customer?.street || customer?.address,
    customer?.street2,
    customer?.city,
    customer?.zip,
  ].filter(Boolean).join(', ')

  const deliveryDate = formatDateOnly((order.deliveryDate ?? order.quotationDate) as string)
  const invoiceDate = formatDateOnly(order.quotationDate as string)

  const linesHtml = lines.map((l, i) => {
    const spec = l.spec
    const note = l.note
    const taxRate = Number(l.taxRate ?? 0)
    const inclVat = Number(l.subtotal) * (1 + taxRate / 100)
    return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="col-qty">${Number(l.orderedQty).toFixed(3)}</td>
        <td class="col-unit">${l.uomName ?? ''}</td>
        <td class="col-desc">
          <div class="prod-name">${l.productName}</div>
          ${spec ? `<div class="prod-spec">${spec}</div>` : ''}
          ${note ? `<div class="prod-note">📝 ${note}</div>` : ''}
        </td>
        <td class="col-price">${eur(l.unitPrice as number)}</td>
        <td class="col-vat">${taxRate > 0 ? formatVatRate(taxRate) : '0%'}</td>
        <td class="col-incl">${eur(inclVat)}</td>
      </tr>`
  }).join('')

  const vatRowsHtml = Object.entries(vatGroups)
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([rate, { vat }]) => `
      <tr>
        <td class="total-label">VAT ${rate}%</td>
        <td class="total-value">${eur(vat)}</td>
      </tr>`).join('')

  const internalNote = order.internalNote ?? ''
  const salesman = order.salesUser?.name ?? ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Invoice ${orderCode}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.12.3/dist/JsBarcode.all.min.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 12mm 10mm; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; border-bottom: 2px solid #333; padding-bottom: 4mm; }
  .company-name { font-size: 22pt; font-weight: bold; color: #111; }
  .company-sub  { font-size: 8pt; color: #555; margin-top: 2px; }
  .company-addr { text-align: right; font-size: 8.5pt; color: #333; line-height: 1.5; }

  /* Info table */
  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 7mm; }
  .info-table td { border: 1px solid #bbb; padding: 3mm 4mm; vertical-align: top; width: 25%; }
  .info-head { font-size: 7.5pt; font-weight: bold; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; border-bottom: 1px solid #ddd; padding-bottom: 1mm; }
  .info-val  { font-size: 9pt; color: #111; line-height: 1.5; }
  .barcode-cell { text-align: center; }
  .barcode-cell svg { max-width: 100%; height: 24mm; }
  .barcode-code { font-size: 9pt; font-weight: bold; margin-top: 1mm; letter-spacing: 1px; }

  /* Lines table */
  .lines-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
  .lines-table thead tr { background: #333; color: #fff; }
  .lines-table thead th { padding: 2.5mm 3mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
  .lines-table tbody tr.row-even { background: #fff; }
  .lines-table tbody tr.row-odd  { background: #f7f7f7; }
  .lines-table tbody td { padding: 2mm 3mm; font-size: 9pt; border-bottom: 1px solid #e8e8e8; vertical-align: top; }

  .col-qty   { text-align: right; width: 10%; }
  .col-unit  { text-align: left;  width: 8%; }
  .col-desc  { text-align: left;  width: 42%; }
  .col-price { text-align: right; width: 13%; }
  .col-vat   { text-align: center; width: 7%; }
  .col-incl  { text-align: right; width: 13%; }

  .prod-name { font-weight: 600; }
  .prod-spec { color: #c00; font-size: 8pt; margin-top: 1px; }
  .prod-note { color: #875A7B; font-size: 8pt; margin-top: 1px; font-style: italic; }

  /* Totals */
  .totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 6mm; }
  .totals-table { width: 220px; border-collapse: collapse; }
  .totals-table tr td { padding: 2mm 3mm; font-size: 9.5pt; border-top: 1px solid #e0e0e0; }
  .total-label { color: #555; }
  .total-value { text-align: right; font-weight: 600; }
  .total-grand .total-label, .total-grand .total-value { font-weight: bold; font-size: 11pt; color: #111; border-top: 2px solid #333; }

  /* Footer */
  .footer { position: fixed; bottom: 8mm; left: 12mm; right: 12mm; border-top: 1px solid #ccc; padding-top: 2mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #666; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 8mm 10mm 18mm; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="company-name">JohnstoneBros</div>
      <div class="company-sub">Wholesale Fresh Produce &amp; Grocery</div>
    </div>
    <div class="company-addr">
      Unit 1, Westgate Business Park, Ballymount<br/>
      Dublin 24, D24 X0Y0, Ireland<br/>
      Tel: +353 1 234 5678<br/>
      VAT: IE1234567T
    </div>
  </div>

  <!-- Info table -->
  <table class="info-table">
    <tr>
      <td>
        <div class="info-head">Customer</div>
        <div class="info-val">
          <strong>${order.restaurantName}</strong><br/>
          ${customerAddr ? customerAddr + '<br/>' : ''}
          ${deliveryBatch ? 'Driver: ' + deliveryBatch : ''}
        </div>
      </td>
      <td class="barcode-cell">
        <div class="info-head">Invoice NO</div>
        <svg id="barcode"></svg>
        <div class="barcode-code">${orderCode}</div>
      </td>
      <td>
        <div class="info-head">Delivery</div>
        <div class="info-val">
          ${deliveryDate}<br/>
          ${invoiceDate !== deliveryDate ? 'Invoice: ' + invoiceDate + '<br/>' : ''}
          ${salesman ? 'Salesman: ' + salesman : ''}
        </div>
      </td>
      <td>
        <div class="info-head">Comment</div>
        <div class="info-val">${internalNote || '—'}</div>
      </td>
    </tr>
  </table>

  <!-- Lines -->
  <table class="lines-table">
    <thead>
      <tr>
        <th class="col-qty">QTY</th>
        <th class="col-unit">UNIT</th>
        <th class="col-desc">DESCRIPTION</th>
        <th class="col-price">PRICE</th>
        <th class="col-vat">VAT</th>
        <th class="col-incl">INCL VAT</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml || '<tr><td colspan="6" style="text-align:center;padding:6mm;color:#999">No items</td></tr>'}
    </tbody>
  </table>

  <!-- Totals -->
  <div class="totals-wrap">
    <table class="totals-table">
      <tr>
        <td class="total-label">Subtotal</td>
        <td class="total-value">${eur(subtotal)}</td>
      </tr>
      ${vatRowsHtml}
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">${eur(total)}</td>
      </tr>
    </table>
  </div>

</div><!-- /page -->

<!-- Footer -->
<div class="footer">
  <span>Tel: +353 1 234 5678 &nbsp;|&nbsp; info@johnstonebros.ie &nbsp;|&nbsp; www.johnstonebros.ie &nbsp;|&nbsp; VAT: IE1234567T</span>
  <span>Page 1/1 &nbsp;|&nbsp; Printed: <span id="print-ts"></span></span>
</div>

<script>
  JsBarcode('#barcode', ${JSON.stringify(barcodeValue(orderCode, order.id))}, {
    format: 'CODE128',
    width: 1.5,
    height: 50,
    displayValue: false,
    margin: 0,
  });
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  document.getElementById('print-ts').textContent =
    pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
</script>
</body>
</html>`
}
