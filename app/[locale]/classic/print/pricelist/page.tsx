'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiGet } from '@/lib/api'
import { docBadge } from '@/lib/print/doc-badge'
import { formatDateOnly } from '@/lib/format-date'

interface EnrichedItem {
  id: string
  applyOn: string
  productTemplateId?: string
  productName?: string | null
  productRef?: string | null
  minQty: number
  dateStart?: string | null
  dateEnd?: string | null
  computeType: string
  fixedPrice?: number | null
  percentDiscount?: number | null
  sequence: number
}

interface EnrichedPricelist {
  id: string
  name: string
  currency: string
  items: EnrichedItem[]
  sequence: number
  active: boolean
}

function fmtPrice(item: EnrichedItem, currency: string): string {
  if (item.computeType === 'fixed' && item.fixedPrice != null) {
    return Number(item.fixedPrice).toFixed(2)
  }
  if (item.computeType === 'percentage' && item.percentDiscount != null) {
    return `-${Number(item.percentDiscount).toFixed(2)}%`
  }
  return '0.00'
}

function buildPricelistHtml(pricelists: EnrichedPricelist[]): string {
  const sectionsHtml = pricelists.map(pl => {
    const rows = [...pl.items].sort((a, b) => a.sequence - b.sequence)

    const rowsHtml = rows.length > 0
      ? rows.map(item => `
        <tr>
          <td class="col-product">
            ${item.productRef ? `<span class="product-ref">[${item.productRef}]</span> ` : ''}${item.productName ?? '—'}
          </td>
          <td class="col-minqty">${item.minQty ?? 1}</td>
          <td class="col-date">${formatDateOnly(item.dateStart)}</td>
          <td class="col-date">${formatDateOnly(item.dateEnd)}</td>
          <td class="col-price">${fmtPrice(item, pl.currency)}</td>
        </tr>`).join('')
      : `<tr><td colspan="5" class="empty-row">No pricing rules</td></tr>`

    return `
<div class="pricelist-section">
  <div class="pricelist-title">Pricelist: ${pl.name}</div>
  <table class="price-table">
    <thead>
      <tr>
        <th class="col-product">Product</th>
        <th class="col-minqty">Min.Qty</th>
        <th class="col-date">Start Date</th>
        <th class="col-date">End Date</th>
        <th class="col-price">Price</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</div>`
  }).join('')

  return `
<div class="page-header">
  <div class="company-name">JohnstoneBros</div>
  <div class="company-addr">
    JohnstoneBros Ltd<br/>
    141 Slaney Close<br/>
    Dublin 11, D11 C3NX<br/>
    Ireland
  </div>
</div>
<hr class="header-rule"/>

<div class="content">
  ${sectionsHtml}
</div>

<div class="page-footer">
  <hr class="footer-rule"/>
  <div class="footer-info">
    Tel: (01) 830 8065 / 018308068 / 0879318299 &nbsp;|&nbsp; Mail: info@johnstonebros.ie &nbsp;|&nbsp; Web: https://m.johnstonebros.ie/ &nbsp;|&nbsp; VAT: IE9739451J
  </div>
</div>`
}

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10pt;
  color: #111;
  background: #fff;
}

/* ── Page layout ── */
.page-wrap {
  width: 210mm;
  margin: 0 auto;
  padding: 14mm 14mm 28mm;
  position: relative;
  min-height: 297mm;
}

/* ── Header ── */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding-bottom: 4mm;
}
.company-name {
  font-size: 28pt;
  font-weight: bold;
  font-style: italic;
  color: #1a3a2a;
  letter-spacing: -0.5px;
}
.company-addr {
  text-align: right;
  font-size: 8.5pt;
  color: #444;
  line-height: 1.7;
}
.header-rule {
  border: none;
  border-top: 1.5px solid #1a3a2a;
  margin-bottom: 12mm;
}

/* ── Pricelist section ── */
.content {
  /* space after header rule is handled by header-rule margin-bottom */
}
.pricelist-section {
  margin-bottom: 10mm;
  page-break-inside: avoid;
}
.pricelist-title {
  font-size: 20pt;
  font-weight: 300;
  color: #111;
  margin-bottom: 4mm;
}

/* ── Table ── */
.price-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5pt;
}
.price-table thead tr {
  background: #f0f0f0;
}
.price-table thead th {
  border: 1px solid #bbb;
  padding: 2.5mm 3mm;
  text-align: left;
  font-size: 8pt;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #333;
}
.price-table tbody td {
  border: 1px solid #ccc;
  padding: 2mm 3mm;
  vertical-align: middle;
  color: #111;
}
.col-product { width: 55%; }
.col-minqty  { width: 10%; }
.col-date    { width: 15%; }
.col-price   { width: 10%; text-align: right; }
.price-table thead th.col-price { text-align: right; }

.product-ref {
  color: #666;
  font-size: 8.5pt;
}
.empty-row {
  text-align: center;
  color: #999;
  padding: 5mm 3mm;
  font-style: italic;
}

/* ── Footer (fixed at bottom of each printed page) ── */
.page-footer {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  padding: 0 14mm 5mm;
  background: #fff;
}
.footer-rule {
  border: none;
  border-top: 1px solid #ccc;
  margin-bottom: 2mm;
}
.footer-info {
  font-size: 7.5pt;
  color: #555;
  line-height: 1.6;
}

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page-wrap { padding: 10mm 14mm 28mm; }
  .pricelist-section { page-break-inside: avoid; }
}
`

export default function PricelistPrintPage() {
  const searchParams = useSearchParams()
  const ids = searchParams.get('ids') ?? ''
  const [html, setHtml] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const query = ids ? `?ids=${ids}` : ''
    apiGet<EnrichedPricelist[]>(`/api/pricelists/print${query}`)
      .then(pricelists => {
        const body = buildPricelistHtml(pricelists)
        const title = pricelists.length === 1 ? `Pricelist – ${pricelists[0].name}` : 'Customer Pricelist Report'
        setHtml(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page-wrap">
<div style="margin-bottom:4mm;">${docBadge('pricelist')}</div>
${body}
</div>
<script>
  // 打印在本文档(iframe)自己的脚本里触发，父页面只 postMessage 通知，不直接调用
  // contentWindow.print()——后者是同步跨窗口调用，会连带卡住父页面的事件循环。
  window.addEventListener('message', function(e){ if (e.data === 'print' && e.source === window.parent) window.print(); });
<\/script>
</body>
</html>`)
        setReady(true)
      })
      .catch(err => {
        setHtml(`<html><body><p style="color:red;padding:20px">${err instanceof Error ? err.message : '加载失败'}</p></body></html>`)
        setReady(true)
      })
  }, [ids])

  useEffect(() => {
    if (ready && html) {
      const iframe = document.getElementById('print-frame') as HTMLIFrameElement | null
      if (!iframe) return
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document
      if (!doc) return
      doc.open()
      doc.write(html)
      doc.close()
    }
  }, [ready, html])

  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial, sans-serif', color: '#666' }}>
        Loading pricelist…
      </div>
    )
  }

  return (
    <>
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        background: '#1a3a2a', padding: '8px 16px',
        display: 'flex', alignItems: 'center', gap: '12px',
      }}>
        <button
          onClick={() => (document.getElementById('print-frame') as HTMLIFrameElement)?.contentWindow?.postMessage('print', '*')}
          style={{
            background: '#fff', color: '#1a3a2a', border: 'none',
            padding: '6px 18px', borderRadius: '4px', fontWeight: 'bold',
            cursor: 'pointer', fontSize: '13px',
          }}
        >
          🖨 Print / Save PDF
        </button>
        <span style={{ color: '#a8c8b0', fontSize: '13px' }}>Customer Pricelist Report</span>
      </div>
      <iframe
        id="print-frame"
        style={{ position: 'fixed', top: '40px', left: 0, right: 0, bottom: 0, width: '100%', height: 'calc(100% - 40px)', border: 'none' }}
        title="Pricelist Print"
      />
    </>
  )
}
