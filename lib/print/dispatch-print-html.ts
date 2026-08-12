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
import { generateTripPickingHtml, type PickingVariant } from '@/lib/print/trip-picking-template'
import { generateTripDeliveryHtml } from '@/lib/print/trip-delivery-template'
import { generateTripSalesHtml } from '@/lib/print/trip-sales-template'
import { type PrintContentFilter, appendPrintFilterParams } from '@/lib/print/print-filters'

export type DispatchPrintType = 'summary' | 'picking' | 'delivery' | 'sales'

export const DISPATCH_PRINT_RENDERERS: Record<DispatchPrintType, (d: TripPrintData, variant?: PickingVariant) => string> = {
  summary: generateTripSummaryHtml,
  picking: generateTripPickingHtml,
  delivery: generateTripDeliveryHtml,
  sales: generateTripSalesHtml,
}

export const DISPATCH_PRINT_TITLES: Record<DispatchPrintType, string> = {
  summary: '送货汇总单',
  picking: '拣货单 · 备货清单',
  delivery: '送货单 · DELIVERY SLIP',
  sales: '销售单 · SALES ORDER',
}

export function parsePickingVariant(v: string | null | undefined): PickingVariant {
  return v === 'storable' || v === 'consumable' ? v : 'all'
}

export interface DispatchPrintParams extends PrintContentFilter {
  type: DispatchPrintType
  date: string
  fromDate?: string
  driverSlotId?: string
  batchLabel?: string
  waveIds?: string[]
  variant?: PickingVariant
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
  appendPrintFilterParams(params, p)
  return params
}

export async function fetchDispatchPrintHtml(p: DispatchPrintParams): Promise<string> {
  const params = buildDispatchParams(p)
  params.delete('variant') // 变体只影响渲染，取数接口不认这个参数
  const wire = await apiGet<TripPrintDataWire>(`/api/orders/dispatch-print-data?${params}`)
  const data = toMemoryShape(wire)
  return DISPATCH_PRINT_RENDERERS[p.type](data, p.variant)
}

/** 汇总单走真·服务端 PDF：路由参数与上面的 print-data 接口一致，见 app/api/print/dispatch-summary-pdf */
export function buildDispatchSummaryPdfUrl(p: Omit<DispatchPrintParams, 'type' | 'variant'>): string {
  return `/api/print/dispatch-summary-pdf?${buildDispatchParams(p)}`
}

/** 拣货单走真·服务端 PDF：路由参数与上面的 print-data 接口一致，见 app/api/print/dispatch-picking-pdf */
export function buildDispatchPickingPdfUrl(p: Omit<DispatchPrintParams, 'type'>): string {
  return `/api/print/dispatch-picking-pdf?${buildDispatchParams(p)}`
}
