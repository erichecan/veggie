'use client'
import { useState, useEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'
import { useParams, useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { barcodeValue } from '@/lib/barcode'
import { DOCUMENT_HEADER_CSS, documentHeader, paymentDetails } from '@/lib/print/document-header'
import type { Customer, Invoice } from '@/lib/types'
import { formatDateOnly } from '@/lib/format-date'
import { toInvoiceLineViews, isOrderBasedInvoice, formatMoney } from '@/lib/invoice-lines-view'
import { GiftAmount } from '@/components/shared/gift-amount'

const PURPLE = '#875A7B'
const STATUS_LABELS = {
  en: { draft: 'Draft', posted: 'Posted', paid: 'Paid', cancelled: 'Cancelled' },
  zh: { draft: '草稿', posted: '已确认', paid: '已付款', cancelled: '已取消' },
}

export default function InvoicePrintPage() {
  const params = useParams()
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const [inv, setInv] = useState<Invoice | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loaded, setLoaded] = useState(false)
  const barcodeRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!barcodeRef.current || !inv) return
    const code = barcodeValue(inv.name, inv.id)
    try {
      JsBarcode(barcodeRef.current, code, { format: 'CODE128', width: 1.5, height: 32, displayValue: false, margin: 0 })
    } catch {}
  }, [inv])

  useEffect(() => {
    apiGet<Invoice>(`/api/invoices/${params.id}`)
      .then(async found => {
        setInv(found ? { ...found, status: (found.status?.toLowerCase() as Invoice['status']) ?? found.status } : null)
        if (found?.customerId) {
          try { setCustomer(await apiGet<Customer>(`/api/customers/${found.customerId}`)) } catch { setCustomer(null) }
        }
      })
      .catch(() => setInv(null))
      .finally(() => setLoaded(true))
  }, [params.id])

  if (loaded && !inv) {
    return (
      <div className="text-center py-20 text-gray-400">
        {isEn ? 'Invoice not found or has been deleted' : '发票不存在或已删除'}
        <div className="mt-4">
          <button
            onClick={() => router.push(`${prefix}/classic/finance/invoices`)}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            {isEn ? 'Back to list' : '返回列表'}
          </button>
        </div>
      </div>
    )
  }

  if (!inv) {
    return <div className="text-center py-20 text-gray-400">{isEn ? 'Loading…' : '加载中…'}</div>
  }

  // 发票行有两种结构（Odoo 历史的按订单 / 现在开票的按商品明细），统一归一后再渲染
  const lineViews = toInvoiceLineViews(inv.lines, isEn)
  const orderBased = isOrderBasedInvoice(inv.lines)

  return (
    <>
      {/* 打印时隐藏一切，只显示发票区 */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #invoice-print, #invoice-print * { visibility: visible; }
          #invoice-print { position: absolute; top: 0; left: 0; width: 100%; padding: 0; }
          .no-print { display: none !important; }
          /* 多页时每页都要有列名，否则第二页起看不出哪列是什么 */
          thead { display: table-header-group; }
          /* 一行被拦腰切到下一页会看不懂，宁可整行推下去 */
          tbody tr { break-inside: avoid; page-break-inside: avoid; }
        }
        /* 每页边距交给 @page：容器自己的 padding-bottom 只在整份文档末尾生效，
           middle page 会一直排到纸边（同 lib/order-pdf.ts 踩过的坑） */
        @page { size: A4; margin: 12mm 10mm; }
        ${DOCUMENT_HEADER_CSS}
        #invoice-print .info-table td { border:1px solid #bbb; width:25%; vertical-align:top; }
      `}</style>

      {/* 工具栏（不打印） */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(`${prefix}/classic/finance/invoices/${inv.id}`)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          {isEn ? '← Back to invoice details' : '← 返回发票详情'}
        </button>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium text-white hover:opacity-90"
          style={{ background: PURPLE }}
        >
          {isEn ? '🖨 Print / Save as PDF' : '🖨 打印 / 保存 PDF'}
        </button>
      </div>

      {/* 发票主体 */}
      <div id="invoice-print" className="max-w-3xl mx-auto bg-white p-10 my-6 text-gray-800">
        <div dangerouslySetInnerHTML={{ __html: documentHeader('invoice') }} />
        <table className="info-table w-full border-collapse">
          <tbody><tr>
            <td><div className="info-head">{isEn ? 'Customer' : '客户'}</div><div className="info-val">{inv.customerName}<br/><span className="text-gray-500">{STATUS_LABELS[isEn ? 'en' : 'zh'][inv.status]}</span></div></td>
            <td className="barcode-cell"><div className="info-head">{isEn ? 'Invoice No.' : '发票号'}</div><svg ref={barcodeRef} /><div className="barcode-code">{inv.name}</div></td>
            <td><div className="info-head">{isEn ? 'Dates' : '日期'}</div><div className="info-val">{formatDateOnly(inv.createdAt)}<br/>{isEn ? 'Due: ' : '到期：'}{formatDateOnly(inv.dueDate)}<br/>{isEn ? 'Related orders: ' : '关联订单：'}{inv.saleOrderIds.length}</div></td>
            <td><div className="info-head">{isEn ? 'Payment' : '付款方式'}</div><div className="info-val" dangerouslySetInnerHTML={{ __html: paymentDetails(inv.paymentTerms ?? customer?.paymentTerm, [customer?.externalNote], isEn ? 'en' : 'zh') }} /></td>
          </tr></tbody>
        </table>

        {/* 明细表：两种行结构共用一套视图模型，见 lib/invoice-lines-view.ts */}
        <table className="w-full text-xs mb-4">
          <thead>
            <tr className="text-xs text-gray-500 uppercase border-b-2 border-gray-200">
              <th className="text-left py-1 font-medium">{orderBased ? (isEn ? 'Sales order' : '销售订单') : (isEn ? 'Item' : '商品')}</th>
              {!orderBased && <>
                <th className="text-center py-1 font-medium">{isEn ? 'Qty' : '数量'}</th>
                <th className="text-right py-1 font-medium">{isEn ? 'Unit price' : '单价'}</th>
                <th className="text-center py-1 font-medium">{isEn ? 'Tax rate' : '税率'}</th>
                <th className="text-right py-1 font-medium">{isEn ? 'Ex. tax' : '税前'}</th>
                <th className="text-right py-1 font-medium">{isEn ? 'Tax' : '税额'}</th>
              </>}
              <th className="text-right py-1 font-medium">{orderBased ? (isEn ? 'Amount' : '金额') : (isEn ? 'Inc. tax' : '含税')}</th>
            </tr>
          </thead>
          <tbody>
            {lineViews.map((line, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-1">
                  <p className="font-medium text-gray-800">{line.title}</p>
                  {line.subtitle && <p className="text-xs text-gray-400">{line.subtitle}</p>}
                </td>
                {!orderBased && <>
                  <td className="py-1 text-center">{line.qty}</td>
                  <td className="py-1 text-right"><GiftAmount isGift={line.isGift} value={formatMoney(line.unitPrice)} /></td>
                  <td className="py-1 text-center text-gray-500">{((line.taxRate ?? 0) * 100).toFixed(1)}%</td>
                  <td className="py-1 text-right"><GiftAmount isGift={line.isGift} value={formatMoney(line.subtotalExTax)} /></td>
                  <td className="py-1 text-right text-gray-500">{formatMoney(line.taxAmount)}</td>
                </>}
                <td className="py-1 text-right font-medium"><GiftAmount isGift={line.isGift} value={formatMoney(line.amount)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 汇总 */}
        <div className="flex justify-end">
          <div className="w-72 space-y-1.5 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>{isEn ? 'Subtotal (ex. tax)' : '税前小计'}</span>
              <span>€{inv.subtotalExTax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>{isEn ? 'Total VAT' : 'VAT 税额合计'}</span>
              <span>€{inv.totalTax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-300 pt-2">
              <span>{isEn ? 'Total (inc. tax)' : '含税总额'}</span>
              <span>€{inv.totalIncTax.toFixed(2)}</span>
            </div>
            {inv.amountPaid > 0 && (
              <div className="flex justify-between text-green-600">
                <span>{isEn ? 'Paid' : '已付款'}</span>
                <span>€{inv.amountPaid.toFixed(2)}</span>
              </div>
            )}
            <div className={`flex justify-between font-bold ${inv.amountDue > 0 ? 'text-orange-600' : 'text-green-600'}`}>
              <span>{isEn ? 'Amount due' : '待收款'}</span>
              <span>€{inv.amountDue.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* 页脚 */}
        <div className="mt-10 pt-5 border-t border-gray-200 text-xs text-gray-400 text-center">
          {isEn
            ? 'Thank you for your business · For any questions about this invoice, please contact the Veggie finance team · This invoice is generated automatically'
            : '感谢您的惠顾 · 如对本发票有疑问，请联系 Veggie 财务部 · 本发票由系统自动生成'}
        </div>
      </div>
    </>
  )
}
