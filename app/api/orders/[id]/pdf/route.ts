import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'

function fmt(iso?: string | Date | null): string {
  if (!iso) return '—'
  const d = new Date(iso as string)
  if (isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

function eur(v: unknown): string {
  const n = Number(v)
  return isNaN(n) ? '0.00' : n.toFixed(2)
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { sequence: 'asc' } },
        driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
      },
    })
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    const customer = order.restaurantId
      ? await prisma.customer.findUnique({ where: { id: order.restaurantId } })
      : null

    const lines = order.lines ?? []

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

    const orderCode = (order as unknown as { code?: string }).code ?? order.id.slice(-8).toUpperCase()

    const customerAddr = [
      customer?.street || customer?.address,
      customer?.street2,
      customer?.city,
      customer?.zip,
    ].filter(Boolean).join(', ')

    const deliveryDate = fmt((order as unknown as { deliveryDate?: string }).deliveryDate ?? order.quotationDate)
    const invoiceDate = fmt((order as unknown as { quotationDate?: string }).quotationDate)

    const linesHtml = lines.map((l, i) => {
      const spec = (l as unknown as { spec?: string }).spec
      const note = (l as unknown as { note?: string }).note
      const taxRate = Number(l.taxRate ?? 0)
      const inclVat = Number(l.subtotal) * (1 + taxRate / 100)
      return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="col-qty">${Number(l.orderedQty).toFixed(3)}</td>
        <td class="col-unit">${(l as unknown as { uomName?: string }).uomName ?? ''}</td>
        <td class="col-desc">
          <div class="prod-name">${l.productName}</div>
          ${spec ? `<div class="prod-spec">${spec}</div>` : ''}
          ${note ? `<div class="prod-note">📝 ${note}</div>` : ''}
        </td>
        <td class="col-price">${eur(l.unitPrice)}</td>
        <td class="col-vat">${taxRate > 0 ? taxRate.toFixed(0) + '%' : '0%'}</td>
        <td class="col-incl">${eur(inclVat)}</td>
      </tr>`
    }).join('')

    const vatRowsHtml = Object.entries(vatGroups)
      .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
      .map(([rate, { vat }]) => `
      <tr>
        <td class="total-label">VAT ${rate}%</td>
        <td class="total-value">€${eur(vat)}</td>
      </tr>`).join('')

    const internalNote = (order as unknown as { internalNote?: string }).internalNote ?? ''
    const salesman = (order as unknown as { salesman?: string }).salesman ?? ''
    const deliveryBatch = formatDriverSlotFromOrder(order as unknown as { driverSlot?: { id: string; batchNum: number; timeOfDay: string; driverName: string } | null; deliveryBatch?: string | null })

    const html = `<!DOCTYPE html>
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
        <td class="total-value">€${eur(subtotal)}</td>
      </tr>
      ${vatRowsHtml}
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">€${eur(total)}</td>
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
  JsBarcode('#barcode', ${JSON.stringify(orderCode)}, {
    format: 'CODE128',
    width: 1.5,
    height: 50,
    displayValue: false,
    margin: 0,
  });
  document.getElementById('print-ts').textContent = new Date().toLocaleString('en-GB');
</script>
</body>
</html>`

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[GET /api/orders/[id]/pdf]', error)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
