/**
 * 打印模板预览页 · 服务端模板渲染
 * ============================================================================
 * 把「能纯函数渲染」的那批模板用真实 loader + 真实模板函数产出 HTML 文件。
 * 数据来自生产库快照（本地隔离容器），因此产出的纸张就是客户实际会拿到的样子。
 *
 * 不走 HTTP、不碰任何写操作 —— 打印路由里的副作用（pick-lock 锁波次、
 * mark-printed 写打印痕迹）都在 route 层，这里只调 loader 和模板。
 *
 * 用法：
 *   DATABASE_URL=... npx tsx scripts/print-preview/render-server-templates.ts <输出目录>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@/lib/db'
import { toMemoryShape, stripAutoPrintScript } from '@/lib/print/trip-common'
import { loadDispatchPrintData } from '@/lib/print/dispatch-loader'
import { loadTripPrintData } from '@/lib/print/trip-loader'
import { DISPATCH_PRINT_RENDERERS } from '@/lib/print/dispatch-print-html'
import { loadDayWiseReportData } from '@/lib/print/day-wise-report-loader'
import {
  buildOrderSummaryHtml,
  buildMultilineHtml,
  buildSummaryHtml,
} from '@/lib/print/day-wise-report-template'
import { renderPurchaseOrderHtml } from '@/lib/purchase-order-pdf'

const outDir = process.argv[2]
if (!outDir) throw new Error('用法：render-server-templates.ts <输出目录>')
mkdirSync(outDir, { recursive: true })

const written: { file: string; label: string; bytes: number }[] = []

/**
 * 预览页专用的自动打印剥离。
 *
 * 生产的 stripAutoPrintScript 只匹配独立的 <script>window.print();</script> 块，
 * 而销售单/送货单模板把 window.print() 和 JsBarcode 初始化写在同一个 script 里，
 * 那个正则匹配不到（生产上没暴露是因为这两张单走客户端打印、本来就要弹框）。
 * 预览页是拿来看的，这里补一刀：只删 window.print() 这条语句，条码逻辑留着。
 */
function stripAutoPrintForPreview(html: string): string {
  return stripAutoPrintScript(html).replace(/^\s*window\.print\(\);?\s*$/gm, '')
}

function emit(file: string, label: string, rawHtml: string) {
  const html = stripAutoPrintForPreview(rawHtml)
  writeFileSync(join(outDir, file), html, 'utf8')
  written.push({ file, label, bytes: Buffer.byteLength(html) })
  console.log(`  ✓ ${file}  (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)  ${label}`)
}

async function renderDispatchFamily() {
  // 9-13 BAO 那趟车：7 单 5 客户 1 托盘，是快照里配送数据最完整的一批
  const DATE = '2026-09-13'
  const wave = await prisma.pickingWave.findFirst({
    where: { waveDate: { gte: new Date(`${DATE}T00:00:00Z`), lte: new Date(`${DATE}T23:59:59Z`) } },
    orderBy: { waveNumber: 'asc' },
  })
  if (!wave) {
    console.log('  ⚠️ 找不到波次，跳过配送五件套')
    return
  }
  console.log(`\n[配送类] date=${DATE} wave=${wave.name} orders=${wave.orderIds.length}`)

  const wire = await loadDispatchPrintData(DATE, { waveIds: [wave.id] })
  if (!wire) {
    console.log('  ⚠️ loadDispatchPrintData 返回空')
    return
  }
  const data = toMemoryShape(wire)

  for (const lang of ['zh', 'en'] as const) {
    emit(`01-picking-all-${lang}.html`, `拣货单（全部）${lang}`, DISPATCH_PRINT_RENDERERS.picking(data, 'all', lang, 'auto'))
  }
  emit('01-picking-storable-zh.html', '拣货单（整箱整袋）', DISPATCH_PRINT_RENDERERS.picking(data, 'storable', 'zh', 'auto'))
  emit('01-picking-consumable-zh.html', '拣货单（零散货）', DISPATCH_PRINT_RENDERERS.picking(data, 'consumable', 'zh', 'auto'))
  emit('02-delivery-zh.html', '送货单', DISPATCH_PRINT_RENDERERS.delivery(data, undefined, 'zh', undefined))
  emit('02-delivery-en.html', '送货单 EN', DISPATCH_PRINT_RENDERERS.delivery(data, undefined, 'en', undefined))
  emit('03-sales-zh.html', '销售单', DISPATCH_PRINT_RENDERERS.sales(data, undefined, 'zh', undefined))
  emit('03-sales-en.html', '销售单 EN', DISPATCH_PRINT_RENDERERS.sales(data, undefined, 'en', undefined))
  emit('04-summary-zh.html', '送货汇总单', DISPATCH_PRINT_RENDERERS.summary(data, undefined, 'zh', undefined))
  emit('04-summary-en.html', '送货汇总单 EN', DISPATCH_PRINT_RENDERERS.summary(data, undefined, 'en', undefined))
}

async function renderDayWise() {
  // 口径注意：loader 的 STATUS_FILTER 只认 CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY/COMPLETED。
  // 快照里 7/6–7/10 那 669 单全是 LOCKED，会被整批过滤掉（这是系统真实行为，不是取数错误），
  // 所以日期范围放宽到 7 月~9 月，把状态命中的那批订单都收进来。
  const params = {
    fromDate: '2026-07-01',
    toDate: '2026-09-30',
    customerIds: [],
    productNames: [],
    drivers: [],
    times: [],
    batchNums: [],
    weekdays: [],
    categoryIds: [],
    salesUserId: '',
  }
  console.log(`\n[日报三件套] ${params.fromDate} ~ ${params.toDate}`)
  const { lines, orders } = await loadDayWiseReportData(params)
  console.log(`  取到 ${orders.length} 单 / ${lines.length} 行`)
  const meta = `${params.fromDate} ~ ${params.toDate} · ${orders.length} orders`

  emit('11a-day-summary-en.html', '订单汇总报表', buildOrderSummaryHtml(lines, orders, 'Order Summary', meta, 'en'))
  emit('11a-day-summary-zh.html', '订单汇总报表 ZH', buildOrderSummaryHtml(lines, orders, '订单汇总报表', meta, 'zh'))
  emit('11b-multiline-en.html', '商品明细清单', buildMultilineHtml(lines, 'Product Lines', meta, false, 'en'))
  emit('11c-weekly-summary-en.html', '商品×星期汇总', buildSummaryHtml(lines, 'Weekly Summary', meta, false, 'en'))
}

async function renderPurchaseOrders() {
  console.log('\n[采购单/询价单]')
  const posted = await prisma.purchaseOrder.findFirst({
    where: { status: { not: 'DRAFT' } },
    include: { lines: true },
    orderBy: { createdAt: 'desc' },
  })
  const draft = await prisma.purchaseOrder.findFirst({
    where: { status: 'DRAFT' },
    include: { lines: true },
    orderBy: { createdAt: 'desc' },
  })

  for (const [po, file, label] of [
    [posted, '09-purchase-order.html', '采购单 PURCHASE ORDER'],
    [draft, '09-purchase-rfq.html', '询价单 RFQ'],
  ] as const) {
    if (!po) {
      console.log(`  ⚠️ 没有匹配的采购单，跳过 ${file}`)
      continue
    }
    const supplier = po.supplierId
      ? await prisma.customer.findUnique({ where: { id: po.supplierId } })
      : null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(file, `${label}（${po.lines.length} 行）`, renderPurchaseOrderHtml(po as any, supplier as any))
  }
}

async function main() {
  console.log('渲染服务端模板 →', outDir)
  await renderDispatchFamily()
  await renderDayWise()
  await renderPurchaseOrders()

  writeFileSync(join(outDir, '_server-manifest.json'), JSON.stringify(written, null, 2))
  console.log(`\n共产出 ${written.length} 个 HTML`)
}

main()
  .catch(e => { console.error('渲染失败：', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
