'use client'
import { useEffect, useRef, useState } from 'react'
import { apiGet } from '@/lib/api'
import type { Order, Customer } from '@/lib/types'
import { buildOrderHtml, CSS } from '../[id]/page'

type PrintOrder = Order & {
  code?: string
  deliveryDate?: string
  internalNote?: string
  externalNote?: string
  salesman?: string
  deliveryBatch?: string
}

export default function BatchPrintPage() {
  const [html, setHtml] = useState<string>('')
  const [ready, setReady] = useState(false)
  const [isPreview, setIsPreview] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    async function load() {
      try {
        const search = new URLSearchParams(window.location.search)
        const ids = (search.get('ids') ?? '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        const docParam = search.get('doc')
        const preview = search.get('preview') === '1'
        setIsPreview(preview)
        const docType: 'delivery' | 'sales' | undefined =
          docParam === 'delivery' ? 'delivery' : docParam === 'sales' ? 'sales' : undefined
        const docTitle = docType === 'delivery' ? 'Delivery Note' : docType === 'sales' ? 'Sale Order' : 'Invoice'

        if (ids.length === 0) {
          setHtml('<!DOCTYPE html><html><body style="font-family:Arial;color:#666;padding:40px">No orders to print.</body></html>')
          setReady(true)
          return
        }

        const [orders, customers] = await Promise.all([
          Promise.all(ids.map(id => apiGet<PrintOrder>(`/api/orders/${id}`).catch(() => null))),
          apiGet<Customer[]>('/api/customers').catch(() => [] as Customer[]),
        ])
        const validOrders = orders.filter((o): o is PrintOrder => o != null)

        const bodyHtml = validOrders
          .map((order, i) => {
            const customer = customers.find(c => c.id === order.restaurantId) ?? null
            return buildOrderHtml(order, customer, {
              docType,
              pageBreakAfter: i < validOrders.length - 1,
            })
          })
          .join('\n')

        setHtml(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${docTitle}（${validOrders.length} 单）</title>
<style>${CSS}</style>
</head>
<body>
${bodyHtml}

<div class="footer-fixed">
  <hr class="footer-divider"/>
  <div class="footer-lines">
    Tel: (01) 830 8065 / 018308068 / 0879318299 &nbsp;&nbsp; Mail: info@johnstonebros.ie | johnstoneveg@gmail.com<br/>
    Web: https://m.johnstonebros.ie/ &nbsp;&nbsp; VAT: IE9739451J
  </div>
  <div class="footer-page-row">
    <span>Orders: ${validOrders.length}</span>
    <span>Print at: <span id="print-ts"></span></span>
  </div>
</div>

<script>
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  document.getElementById('print-ts').textContent =
    pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
  // 打印在本文档(iframe)自己的脚本里触发，父页面只 postMessage 通知，不直接调用
  // contentWindow.print()——后者是同步跨窗口调用，会连带卡住父页面的事件循环。
  window.addEventListener('message', function(e){ if (e.data === 'print' && e.source === window.parent) window.print(); });
  ${preview ? '' : 'window.print();'}
<\/script>
</body>
</html>`)
        setReady(true)
      } catch (e) {
        console.error('Batch print page load failed:', e)
        setReady(true)
      }
    }
    load()
  }, [])

  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial, sans-serif', color: '#666' }}>
        Loading…
      </div>
    )
  }

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={html}
        title="batch-print"
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', border: 'none' }}
      />
      {isPreview && (
        <button
          onClick={() => iframeRef.current?.contentWindow?.postMessage('print', '*')}
          style={{
            position: 'fixed', top: 12, right: 12, zIndex: 10,
            padding: '8px 16px', fontSize: 14, fontWeight: 600,
            background: '#875A7B', color: '#fff', border: 'none', borderRadius: 6,
            cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          }}
        >
          🖨 Print
        </button>
      )}
    </>
  )
}
