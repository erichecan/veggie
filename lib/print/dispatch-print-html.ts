/**
 * 调度打印(拣货单/送货单/汇总单/销售单)的数据获取 + HTML 生成，供两处复用：
 * - _DispatchPrintClient.tsx：整页导航打开的打印路由(/classic/print/dispatch/[type])
 * - PrintCenter.tsx：直接在页面内生成 HTML 灌进隐藏 iframe 的 srcDoc，不经过整页导航——
 *   因为整页导航会撞上全站 X-Frame-Options: DENY / frame-ancestors 'none'(next.config.ts)，
 *   把这条打印页面在 iframe.src 里跨路由加载的路径直接拒绝渲染；srcDoc 是内联文档，不发起
 *   HTTP 导航，不受这两个响应头管辖，因此绕开了这个限制。
 */
import { apiGet } from '@/lib/api'
import { type TripPrintData, type TripPrintDataWire, toMemoryShape } from '@/lib/print/trip-common'
import { generateTripSummaryHtml } from '@/lib/print/trip-summary-template'
import { generateTripPickingHtml, type PickingVariant, type PickingExpandMode } from '@/lib/print/trip-picking-template'
import { generateTripDeliveryHtml } from '@/lib/print/trip-delivery-template'
import { generateTripSalesHtml } from '@/lib/print/trip-sales-template'
import { type PrintContentFilter, appendPrintFilterParams } from '@/lib/print/print-filters'
import { resolvePrintLang, type PrintLang } from '@/lib/print/print-i18n'

export type DispatchPrintType = 'summary' | 'picking' | 'delivery' | 'sales'

/**
 * 统一签名 (data, variant, lang, expand)——只有 picking 真的用 variant/expand，其余三个
 * 模板的生成函数是 (data, lang) 两参，这里包一层把这几个参数都摆在固定位置，调用方
 * 不用关心每个模板自己的参数个数。
 */
export const DISPATCH_PRINT_RENDERERS: Record<DispatchPrintType, (d: TripPrintData, variant: PickingVariant | undefined, lang: PrintLang, expand: PickingExpandMode | undefined) => string> = {
  summary: (d, _variant, lang) => generateTripSummaryHtml(d, lang),
  picking: (d, variant, lang, expand) => generateTripPickingHtml(d, variant, lang, expand),
  delivery: (d, _variant, lang) => generateTripDeliveryHtml(d, lang),
  sales: (d, _variant, lang) => generateTripSalesHtml(d, lang),
}

const DISPATCH_PRINT_TITLES_BY_LANG: Record<PrintLang, Record<DispatchPrintType, string>> = {
  zh: {
    summary: '送货汇总单',
    picking: '拣货单 · 备货清单',
    delivery: '送货单 · DELIVERY SLIP',
    sales: '销售单 · SALES ORDER',
  },
  en: {
    summary: 'Delivery Summary',
    picking: 'Picking List',
    delivery: 'Delivery Slip',
    sales: 'Sales Order',
  },
}

export function getDispatchPrintTitle(type: DispatchPrintType, lang: PrintLang = 'zh'): string {
  return DISPATCH_PRINT_TITLES_BY_LANG[lang][type]
}

/** @deprecated 用 getDispatchPrintTitle(type, lang) 代替；留着只为兼容还没切过来的调用点 */
export const DISPATCH_PRINT_TITLES = DISPATCH_PRINT_TITLES_BY_LANG.zh

export function parsePickingVariant(v: string | null | undefined): PickingVariant {
  return v === 'storable' || v === 'consumable' ? v : 'all'
}

export function parsePickingExpandMode(v: string | null | undefined): PickingExpandMode {
  return v === 'all' ? 'all' : 'auto'
}

export interface DispatchPrintParams extends PrintContentFilter {
  type: DispatchPrintType
  date: string
  fromDate?: string
  driverSlotId?: string
  batchLabel?: string
  waveIds?: string[]
  variant?: PickingVariant
  /** 拣货单客户展开粒度，见 trip-picking-template.ts 的 PickingExpandMode；只有 picking 用得到 */
  expand?: PickingExpandMode
  lang?: PrintLang
}

/**
 * 三个入口（HTML / 拣货 PDF / 汇总 PDF）的查询参数完全一致，构造只写一份。
 * 之前是三处各抄一遍，新增一个筛选维度要改三处，漏改的表现是
 * 「屏幕上筛了、打出来没筛」——不会报错，只会打错纸。
 * 服务端的解析对侧在 dispatch-loader.parseDispatchSelector()。
 */
function buildDispatchParams(p: Omit<DispatchPrintParams, 'type'>): URLSearchParams {
  const params = new URLSearchParams({ date: p.date })
  if (p.driverSlotId) params.set('driverSlotId', p.driverSlotId)
  if (p.batchLabel) params.set('batchLabel', p.batchLabel)
  if (p.waveIds && p.waveIds.length > 0) params.set('waveIds', p.waveIds.join(','))
  if (p.fromDate) params.set('fromDate', p.fromDate)
  if (p.variant) params.set('variant', p.variant)
  if (p.expand) params.set('expand', p.expand)
  if (p.lang === 'en') params.set('lang', 'en')
  appendPrintFilterParams(params, p)
  return params
}

export async function fetchDispatchPrintHtml(p: DispatchPrintParams): Promise<string> {
  const params = buildDispatchParams(p)
  params.delete('variant') // 变体只影响渲染，取数接口不认这个参数
  params.delete('expand') // 展开粒度只影响渲染，取数接口不认这个参数
  params.delete('lang') // 语言只影响渲染，取数接口不认这个参数
  const wire = await apiGet<TripPrintDataWire>(`/api/orders/dispatch-print-data?${params}`)
  const data = toMemoryShape(wire)
  return DISPATCH_PRINT_RENDERERS[p.type](data, p.variant, resolvePrintLang(p.lang), p.expand)
}

/** 汇总单走真·服务端 PDF：路由参数与上面的 print-data 接口一致，见 app/api/print/dispatch-summary-pdf */
export function buildDispatchSummaryPdfUrl(p: Omit<DispatchPrintParams, 'type' | 'variant'>): string {
  return `/api/print/dispatch-summary-pdf?${buildDispatchParams(p)}`
}

/** 拣货单走真·服务端 PDF：路由参数与上面的 print-data 接口一致，见 app/api/print/dispatch-picking-pdf */
export function buildDispatchPickingPdfUrl(p: Omit<DispatchPrintParams, 'type'>): string {
  return `/api/print/dispatch-picking-pdf?${buildDispatchParams(p)}`
}
