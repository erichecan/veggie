'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
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
  summary: '送货汇总单',
  picking: '拣货单 · 备货清单',
  delivery: '送货单 · DELIVERY SLIP',
}

export default function DispatchPrintClient({ type }: { type: PrintType }) {
  const searchParams = useSearchParams()
  const date = searchParams.get('date')
  const fromDate = searchParams.get('fromDate')
  const driverSlotId = searchParams.get('driverSlotId')
  const batchLabel = searchParams.get('batchLabel')

  const [html, setHtml] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!date || (!driverSlotId && !batchLabel)) {
      setError('缺少参数 date 以及 driverSlotId 或 batchLabel')
      return
    }
    let cancelled = false
    async function load() {
      try {
        const params = new URLSearchParams({ date: date! })
        if (driverSlotId) params.set('driverSlotId', driverSlotId)
        if (batchLabel) params.set('batchLabel', batchLabel)
        if (fromDate) params.set('fromDate', fromDate)
        const wire = await apiGet<TripPrintDataWire>(
          `/api/orders/dispatch-print-data?${params}`,
        )
        if (cancelled) return
        const data = toMemoryShape(wire)
        setHtml(RENDERERS[type](data))
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '加载失败')
      }
    }
    load()
    return () => { cancelled = true }
  }, [date, fromDate, driverSlotId, batchLabel, type])

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial,sans-serif', color: '#dc2626' }}>
        {TITLES[type]} 加载失败：{error}
      </div>
    )
  }

  if (!html) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial,sans-serif', color: '#666' }}>
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
