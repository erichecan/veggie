import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { formatDateOnly } from '@/lib/format-date'
import { eur } from '@/lib/format-money'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const po = await p.purchaseOrder.findUnique({
      where: { id },
      include: { lines: { orderBy: { sequence: 'asc' } } },
    })
    if (!po) return NextResponse.json({ error: '采购单不存在' }, { status: 404 })

    const supplier = await prisma.customer.findUnique({ where: { id: po.supplierId } })
    const lines = po.lines as Array<{
      productName: string
      uomName?: string | null
      orderedQty: unknown
      unitCost: unknown
      taxRate: unknown
      subtotalIncTax: unknown
      bestBefore?: string | null
    }>

    const supplierAddr = [
      supplier?.street || supplier?.address,
      supplier?.street2,
      supplier?.city,
      supplier?.zip,
    ].filter(Boolean).join(', ')

    const orderDate = formatDateOnly(po.orderDate ?? po.createdAt)
    const expectedDate = formatDateOnly(po.expectedDate)

    const linesHtml = lines.map((l, i) => {
      const taxRate = Number(l.taxRate ?? 0)
      return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="col-qty">${Number(l.orderedQty).toFixed(3)}</td>
        <td class="col-unit">${l.uomName ?? ''}</td>
        <td class="col-desc">${l.productName}</td>
        <td class="col-price">${eur(l.unitCost)}</td>
        <td class="col-vat">${taxRate > 0 ? taxRate.toFixed(0) + '%' : '0%'}</td>
        <td class="col-incl">${eur(l.subtotalIncTax)}</td>
      </tr>`
    }).join('')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${po.status === 'DRAFT' ? 'RFQ' : 'Purchase Order'} ${po.name}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 12mm 10mm; }

  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; border-bottom: 2px solid #333; padding-bottom: 4mm; }
  .company-name { font-size: 22pt; font-weight: bold; color: #111; }
  .company-sub  { font-size: 8pt; color: #555; margin-top: 2px; }
  .doc-title { text-align: right; font-size: 16pt; font-weight: bold; color: #875A7B; }
  .doc-sub { text-align: right; font-size: 9pt; color: #555; margin-top: 2px; }

  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 7mm; }
  .info-table td { border: 1px solid #bbb; padding: 3mm 4mm; vertical-align: top; width: 33.33%; }
  .info-head { font-size: 7.5pt; font-weight: bold; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; border-bottom: 1px solid #ddd; padding-bottom: 1mm; }
  .info-val  { font-size: 9pt; color: #111; line-height: 1.5; }

  .lines-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
  .lines-table thead tr { background: #333; color: #fff; }
  .lines-table thead th { padding: 2.5mm 3mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
  .lines-table tbody tr.row-even { background: #fff; }
  .lines-table tbody tr.row-odd  { background: #f7f7f7; }
  .lines-table tbody td { padding: 2mm 3mm; font-size: 9pt; border-bottom: 1px solid #e8e8e8; vertical-align: top; }

  .col-qty   { text-align: right; width: 10%; }
  .col-unit  { text-align: left;  width: 10%; }
  .col-desc  { text-align: left;  width: 40%; }
  .col-price { text-align: right; width: 13%; }
  .col-vat   { text-align: center; width: 7%; }
  .col-incl  { text-align: right; width: 13%; }

  .totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 6mm; }
  .totals-table { width: 220px; border-collapse: collapse; }
  .totals-table tr td { padding: 2mm 3mm; font-size: 9.5pt; border-top: 1px solid #e0e0e0; }
  .total-label { color: #555; }
  .total-value { text-align: right; font-weight: 600; }
  .total-grand .total-label, .total-grand .total-value { font-weight: bold; font-size: 11pt; color: #111; border-top: 2px solid #333; }

  .notes { margin-top: 4mm; font-size: 9pt; color: #333; }
  .notes .info-head { margin-bottom: 1mm; }

  .footer { position: fixed; bottom: 8mm; left: 12mm; right: 12mm; border-top: 1px solid #ccc; padding-top: 2mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #666; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 8mm 10mm 18mm; }
  }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div>
      <div class="company-name">JohnstoneBros</div>
      <div class="company-sub">Wholesale Fresh Produce &amp; Grocery</div>
    </div>
    <div>
      <div class="doc-title">${po.status === 'DRAFT' ? 'REQUEST FOR QUOTATION' : 'PURCHASE ORDER'}</div>
      <div class="doc-sub">${po.name}</div>
    </div>
  </div>

  <table class="info-table">
    <tr>
      <td>
        <div class="info-head">Supplier</div>
        <div class="info-val">
          <strong>${supplier?.name ?? po.supplierId}</strong><br/>
          ${supplierAddr ? supplierAddr + '<br/>' : ''}
          ${supplier?.phone ? 'Tel: ' + supplier.phone + '<br/>' : ''}
          ${supplier?.vatNumber ? 'VAT: ' + supplier.vatNumber : ''}
        </div>
      </td>
      <td>
        <div class="info-head">Order Date</div>
        <div class="info-val">${orderDate}</div>
      </td>
      <td>
        <div class="info-head">Expected Date</div>
        <div class="info-val">${expectedDate || '—'}</div>
      </td>
    </tr>
  </table>

  <table class="lines-table">
    <thead>
      <tr>
        <th class="col-qty">QTY</th>
        <th class="col-unit">UNIT</th>
        <th class="col-desc">DESCRIPTION</th>
        <th class="col-price">UNIT COST</th>
        <th class="col-vat">VAT</th>
        <th class="col-incl">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml || '<tr><td colspan="6" style="text-align:center;padding:6mm;color:#999">No items</td></tr>'}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals-table">
      <tr>
        <td class="total-label">Subtotal</td>
        <td class="total-value">${eur(po.subtotalExTax)}</td>
      </tr>
      <tr>
        <td class="total-label">Tax</td>
        <td class="total-value">${eur(po.totalTax)}</td>
      </tr>
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">${eur(po.totalIncTax)}</td>
      </tr>
    </table>
  </div>

  ${po.notes ? `<div class="notes"><div class="info-head">Notes</div><div>${po.notes}</div></div>` : ''}

</div>

<div class="footer">
  <span>Tel: +353 1 234 5678 &nbsp;|&nbsp; info@johnstonebros.ie &nbsp;|&nbsp; www.johnstonebros.ie &nbsp;|&nbsp; VAT: IE1234567T</span>
  <span>Page 1/1 &nbsp;|&nbsp; Printed: <span id="print-ts"></span></span>
</div>

<script>
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  document.getElementById('print-ts').textContent =
    pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
</script>
</body>
</html>`

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[GET /api/purchase-orders/[id]/pdf]', error)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
