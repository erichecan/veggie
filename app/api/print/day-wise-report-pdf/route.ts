/**
 * GET /api/print/day-wise-report-pdf
 *
 * 「日报（按客户）/明细清单/商品×星期汇总」的真·服务端 PDF：客户反馈(20260718)老版本走
 * window.print()，浏览器自己加的默认页头页脚（打印时间/文档标题/URL/页码）丑且不受控。
 * 改成跟送货单/汇总单一样，服务端 loadDayWiseReportData() 取数据、生成 HTML，用无头
 * Chromium 渲染成 PDF 二进制返回——不接受客户端传来的任意 HTML（避免 SSRF 跳板）。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDayWiseReportData } from '@/lib/print/day-wise-report-loader'
import {
  type PrintMode,
  DAY_NAMES,
  buildOrderSummaryHtml,
  buildMultilineHtml,
  buildSummaryHtml,
} from '@/lib/print/day-wise-report-template'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'
import type { PrintLang } from '@/lib/print/print-i18n'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

/** 这几个 label 是路由自己拼的 meta/页脚摘要，不在 day-wise-report-template.ts 的字典里，单独维护 */
const META_T = {
  en: {
    period: 'Period', allCustomers: 'All customers', allProducts: 'All products',
    customersSelected: (n: number) => `${n} customer(s) selected`,
    productsSelected: (n: number) => `${n} product(s) selected`,
    categoriesSelected: (n: number) => ` · ${n} categor${n > 1 ? 'ies' : 'y'} selected`,
    drivers: 'Drivers', batch: 'Batch#', weekday: 'Weekday',
    allBatches: 'All batches',
    orders: (n: number) => `${n} orders`,
    lines: (n: number) => `${n} lines`,
    cust: (n: number) => `${n} cust`,
    categ: (n: number) => `${n} categ`,
    titles: { day: 'Order Summary Report', multiline: 'Product Sales Multi Line Report', summary: 'Product Sale Summary Report' } as Record<PrintMode, string>,
    genericError: 'Failed to generate report',
  },
  zh: {
    period: '期间', allCustomers: '全部客户', allProducts: '全部产品',
    customersSelected: (n: number) => `已选 ${n} 个客户`,
    productsSelected: (n: number) => `已选 ${n} 个产品`,
    categoriesSelected: (n: number) => ` · 已选 ${n} 个分类`,
    drivers: '司机', batch: '批次#', weekday: '星期',
    allBatches: '全部批次',
    orders: (n: number) => `${n} 单`,
    lines: (n: number) => `${n} 行`,
    cust: (n: number) => `${n} 客户`,
    categ: (n: number) => `${n} 分类`,
    titles: { day: '订单汇总报表', multiline: '产品销售明细报表', summary: '产品销售汇总报表' } as Record<PrintMode, string>,
    genericError: '生成报表失败',
  },
} as const

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    // 这个路由改造前输出恒为英文，默认必须留 'en'（不能像其它路由那样缺参数就退回 'zh'，
    // 否则不传 lang 的旧链接/旧调用方行为会被悄悄改变）
    const lang: PrintLang = searchParams.get('lang') === 'zh' ? 'zh' : 'en'
    const mt = META_T[lang]
    const mode = (searchParams.get('mode') ?? 'day') as PrintMode
    const fromDate = searchParams.get('from') ?? ''
    const toDate = searchParams.get('to') ?? ''
    const customerIds = searchParams.get('customerIds')?.split(',').filter(Boolean) ?? []
    const productNames = searchParams.get('productNames')?.split(',').filter(Boolean) ?? []
    const drivers = searchParams.get('drivers')?.split(',').filter(Boolean) ?? []
    const times = searchParams.get('times')?.split(',').filter(Boolean) ?? []
    const batchNums = searchParams.get('batchNums')?.split(',').map(Number).filter(n => !isNaN(n)) ?? []
    const weekdays = searchParams.get('weekdays')?.split(',').map(Number).filter(n => !isNaN(n)) ?? []
    const categoryIds = searchParams.get('categoryIds')?.split(',').filter(Boolean) ?? []
    const salesUserId = searchParams.get('salesUserId') ?? ''
    const sortBySequence = searchParams.get('sortBySequence') === '1'

    if (!fromDate || !toDate) {
      return NextResponse.json({ error: '缺少参数 from/to' }, { status: 400 })
    }

    try {
      const { lines, orders } = await loadDayWiseReportData({
        fromDate, toDate, customerIds, productNames, drivers, times, batchNums, weekdays, categoryIds, salesUserId,
      })

      const dateLabel = fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`
      const custLabel = customerIds.length > 0 ? mt.customersSelected(customerIds.length) : mt.allCustomers
      const prodLabel = productNames.length > 0 ? mt.productsSelected(productNames.length) : mt.allProducts
      const catLabel = categoryIds.length > 0 ? mt.categoriesSelected(categoryIds.length) : ''
      const batchFilterParts = [
        drivers.length > 0 ? `${mt.drivers}: ${drivers.join(', ')}` : '',
        times.length > 0 ? `${times.map(t => t.toUpperCase()).join('/')}` : '',
        batchNums.length > 0 ? `${mt.batch} ${batchNums.join(', ')}` : '',
        weekdays.length > 0 ? `${mt.weekday}: ${weekdays.map(w => DAY_NAMES[w]).join(', ')}` : '',
      ].filter(Boolean)
      const batchLabel = batchFilterParts.length > 0 ? batchFilterParts.join(' · ') : mt.allBatches
      const countLabel = mode === 'day' ? mt.orders(orders.length) : mt.lines(lines.length)
      const meta = `${mt.period}: ${dateLabel}  |  ${custLabel}  |  ${prodLabel}${catLabel}  |  ${batchLabel}  |  ${countLabel}`

      // 页脚筛选摘要：只列出真正生效的筛选条件（不列 All customers 这类默认值），
      // 一叠纸打乱后靠页脚就能认出这是哪一份筛选结果的第几页（客户要求，20260718）
      const footerParts = [
        dateLabel,
        customerIds.length > 0 ? mt.cust(customerIds.length) : '',
        categoryIds.length > 0 ? mt.categ(categoryIds.length) : '',
        ...batchFilterParts,
      ].filter(Boolean)
      const pageLabel = footerParts.join(' · ')

      const TITLES = mt.titles

      let html: string
      if (mode === 'multiline') {
        html = buildMultilineHtml(lines, TITLES.multiline, meta, sortBySequence, lang)
      } else if (mode === 'summary') {
        html = buildSummaryHtml(lines, TITLES.summary, meta, sortBySequence, lang)
      } else {
        html = buildOrderSummaryHtml(lines, orders, TITLES.day, meta, lang)
      }

      const pdf = await renderHtmlToPdf(html, { pageNumbers: true, pageLabel })
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[GET /api/print/day-wise-report-pdf]', error)
      return NextResponse.json({ error: mt.genericError }, { status: 500 })
    }
  }, { require: 'print.center.access' })
}
