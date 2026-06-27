'use client'
import { useState, useEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import type { Invoice } from '@/lib/types'

const PURPLE = '#875A7B'

const TERM_LABEL: Record<Invoice['paymentTerms'], string> = {
  cash: '现付',
  weekly: '周结',
  monthly: '月结',
}

const STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: '草稿',
  posted: '已确认',
  paid: '已付款',
  cancelled: '已取消',
}

function fmtDate(d?: string): string {
  if (!d) return '—'
  const parsed = new Date(d)
  if (isNaN(parsed.getTime())) return d
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function InvoicePrintPage() {
  const params = useParams()
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [inv, setInv] = useState<Invoice | null>(null)
  const [loaded, setLoaded] = useState(false)
  const barcodeRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!barcodeRef.current || !inv) return
    const code = /^[\x00-\x7F]+$/.test(inv.name) ? inv.name : inv.id
    try {
      JsBarcode(barcodeRef.current, code, { format: 'CODE128', width: 1.5, height: 40, displayValue: false, margin: 0 })
    } catch {}
  }, [inv])

  useEffect(() => {
    apiGet<Invoice>(`/api/invoices/${params.id}`)
      .then(found => setInv(found ? { ...found, status: (found.status?.toLowerCase() as Invoice['status']) ?? found.status } : null))
      .catch(() => setInv(null))
      .finally(() => setLoaded(true))
  }, [params.id])

  if (loaded && !inv) {
    return (
      <div className="text-center py-20 text-gray-400">
        发票不存在或已删除
        <div className="mt-4">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/invoices`)}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            返回列表
          </button>
        </div>
      </div>
    )
  }

  if (!inv) {
    return <div className="text-center py-20 text-gray-400">加载中…</div>
  }

  return (
    <>
      {/* 打印时隐藏一切，只显示发票区 */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #invoice-print, #invoice-print * { visibility: visible; }
          #invoice-print { position: absolute; top: 0; left: 0; width: 100%; padding: 0; }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* 工具栏（不打印） */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(`${prefix}/classic/operator/invoices/${inv.id}`)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← 返回发票详情
        </button>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium text-white hover:opacity-90"
          style={{ background: PURPLE }}
        >
          🖨 打印 / 保存 PDF
        </button>
      </div>

      {/* 发票主体 */}
      <div id="invoice-print" className="max-w-3xl mx-auto bg-white p-10 my-6 text-gray-800">
        {/* 抬头 */}
        <div className="flex items-start justify-between border-b-2 pb-5 mb-6" style={{ borderColor: PURPLE }}>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: PURPLE }}>Veggie 蔬菜供应链</h1>
            <p className="text-xs text-gray-500 mt-1">Fresh Vegetable Supply Chain</p>
          </div>
          <div className="text-right">
            <p className="text-xl font-bold text-gray-900">发票 INVOICE</p>
            <div className="flex justify-end mt-2">
              <svg ref={barcodeRef} style={{ maxWidth: 140 }} />
            </div>
            <p className="text-sm font-mono text-gray-600 mt-1">{inv.name}</p>
            <span className="inline-block mt-2 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
              {STATUS_LABEL[inv.status]}
            </span>
          </div>
        </div>

        {/* 客户 + 日期 */}
        <div className="grid grid-cols-2 gap-6 mb-8 text-sm">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">致客户 BILL TO</p>
            <p className="font-semibold text-gray-900 text-base">{inv.customerName}</p>
            <p className="text-gray-500 mt-1">结款方式：{TERM_LABEL[inv.paymentTerms]}</p>
          </div>
          <div className="text-right space-y-1">
            <div className="flex justify-end gap-3">
              <span className="text-gray-400">开票日期</span>
              <span className="text-gray-800 w-28">{fmtDate(inv.createdAt)}</span>
            </div>
            <div className="flex justify-end gap-3">
              <span className="text-gray-400">到期日</span>
              <span className="font-medium text-gray-900 w-28">{fmtDate(inv.dueDate)}</span>
            </div>
            <div className="flex justify-end gap-3">
              <span className="text-gray-400">关联订单</span>
              <span className="text-gray-600 w-28">{inv.saleOrderIds.length} 个</span>
            </div>
          </div>
        </div>

        {/* 明细表 */}
        <table className="w-full text-sm mb-6">
          <thead>
            <tr className="text-xs text-gray-500 uppercase border-b-2 border-gray-200">
              <th className="text-left py-2 font-medium">商品</th>
              <th className="text-center py-2 font-medium">数量</th>
              <th className="text-right py-2 font-medium">单价</th>
              <th className="text-center py-2 font-medium">税率</th>
              <th className="text-right py-2 font-medium">税前</th>
              <th className="text-right py-2 font-medium">税额</th>
              <th className="text-right py-2 font-medium">含税</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((line, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-2.5">
                  <p className="font-medium text-gray-800">{line.productName}</p>
                  {line.spec && <p className="text-xs text-gray-400">{line.spec}</p>}
                </td>
                <td className="py-2.5 text-center">{line.qty}</td>
                <td className="py-2.5 text-right">€{line.unitPrice.toFixed(2)}</td>
                <td className="py-2.5 text-center text-gray-500">{(line.taxRate * 100).toFixed(1)}%</td>
                <td className="py-2.5 text-right">€{line.subtotalExTax.toFixed(2)}</td>
                <td className="py-2.5 text-right text-gray-500">€{line.taxAmount.toFixed(2)}</td>
                <td className="py-2.5 text-right font-medium">€{line.subtotalIncTax.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 汇总 */}
        <div className="flex justify-end">
          <div className="w-72 space-y-1.5 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>税前小计</span>
              <span>€{inv.subtotalExTax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>VAT 税额合计</span>
              <span>€{inv.totalTax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-300 pt-2">
              <span>含税总额</span>
              <span>€{inv.totalIncTax.toFixed(2)}</span>
            </div>
            {inv.amountPaid > 0 && (
              <div className="flex justify-between text-green-600">
                <span>已付款</span>
                <span>€{inv.amountPaid.toFixed(2)}</span>
              </div>
            )}
            <div className={`flex justify-between font-bold ${inv.amountDue > 0 ? 'text-orange-600' : 'text-green-600'}`}>
              <span>待收款</span>
              <span>€{inv.amountDue.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* 页脚 */}
        <div className="mt-10 pt-5 border-t border-gray-200 text-xs text-gray-400 text-center">
          感谢您的惠顾 · 如对本发票有疑问，请联系 Veggie 财务部 · 本发票由系统自动生成
        </div>
      </div>
    </>
  )
}
