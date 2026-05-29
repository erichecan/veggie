'use client'
import { useEffect, useState, use } from 'react'
import { apiGet } from '@/lib/api'
import {
  type TripPrintData,
  type TripPrintDataWire,
  toMemoryShape,
} from '@/lib/print/trip-common'
import { generateTripSummaryHtml } from '@/lib/print/trip-summary-template'
import { generateTripPickingHtml } from '@/lib/print/trip-picking-template'
import { generateTripDeliveryHtml } from '@/lib/print/trip-delivery-template'

type PrintType = 'summary' | 'picking' | 'delivery'

const RENDERERS: Record<PrintType, (d: TripPrintData) => string> = {
  summary: generateTripSummaryHtml,
  picking: generateTripPickingHtml,
  delivery: generateTripDeliveryHtml,
}

const TITLES: Record<PrintType, string> = {
  summary: '配送汇总单',
  picking: '拣货单 · 备货清单',
  delivery: '送货单 · DELIVERY SLIP',
}

/**
 * Trip 打印客户端组件
 * - apiGet 拿 print-data JSON
 * - 渲染对应模板（模板末尾内嵌 <script>window.print()</script>）
 * - dangerouslySetInnerHTML 注入，浏览器自动弹打印对话框
 */
export default function TripPrintClient({
  params,
  type,
}: {
  params: Promise<{ id: string }>
  type: PrintType
}) {
  const { id } = use(params)
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
        setHtml(renderer(data))
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '加载失败')
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, type])

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

  return <div dangerouslySetInnerHTML={{ __html: html }} style={{ all: 'unset' }} />
}
