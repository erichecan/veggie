'use client'
import { useEffect, useState, use } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiGet } from '@/lib/api'
import {
  type TripPrintData,
  type TripPrintDataWire,
  toMemoryShape,
} from '@/lib/print/trip-common'
import { generateTripSummaryHtml } from '@/lib/print/trip-summary-template'
import { generateTripPickingHtml, type PickingVariant } from '@/lib/print/trip-picking-template'
import { generateTripDeliveryHtml } from '@/lib/print/trip-delivery-template'

type PrintType = 'summary' | 'picking' | 'delivery'

const RENDERERS: Record<PrintType, (d: TripPrintData, variant?: PickingVariant) => string> = {
  summary: generateTripSummaryHtml,
  picking: generateTripPickingHtml,
  delivery: generateTripDeliveryHtml,
}

function parsePickingVariant(v: string | null): PickingVariant {
  return v === 'storable' || v === 'consumable' ? v : 'all'
}

const TITLES: Record<PrintType, string> = {
  summary: '配送汇总单',
  picking: '拣货单 · 备货清单',
  delivery: '送货单 · DELIVERY SLIP',
}

/**
 * Trip 打印客户端组件
 * - apiGet 拿 print-data JSON
 * - 渲染对应模板（模板末尾内嵌 <script>JsBarcode + window.print()</script>）
 * - 用 iframe srcDoc 注入，脚本可执行：条形码渲染 + 自动弹打印对话框
 */
export default function TripPrintClient({
  params,
  type,
}: {
  params: Promise<{ id: string }>
  type: PrintType
}) {
  const { id } = use(params)
  const searchParams = useSearchParams()
  const variant = parsePickingVariant(searchParams.get('variant'))
  const [html, setHtml] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const wire = await apiGet<TripPrintDataWire>(`/api/trips/${id}/print-data`)
        if (cancelled) return
        const data = toMemoryShape(wire)
        const renderer = RENDERERS[type]
        setHtml(renderer(data, variant))
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '加载失败')
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, type, variant])

  if (error) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontFamily:'Arial,sans-serif', color:'#dc2626' }}>
        ❌ {TITLES[type]} 加载失败：{error}
      </div>
    )
  }

  if (!html) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontFamily:'Arial,sans-serif', color:'#666' }}>
        正在准备 {TITLES[type]} …
      </div>
    )
  }

  // 用 iframe srcDoc 渲染：通过 dangerouslySetInnerHTML 注入的 <script>（JsBarcode、
  // window.print）浏览器不会执行；iframe 会把它当完整文档解析，脚本正常运行。
  return (
    <iframe
      title={TITLES[type]}
      srcDoc={html}
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 'none' }}
    />
  )
}
