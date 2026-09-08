'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  type DispatchPrintType,
  getDispatchPrintTitle,
  parsePickingVariant,
  fetchDispatchPrintHtml,
} from '@/lib/print/dispatch-print-html'
import type { PrintLang } from '@/lib/print/print-i18n'

type PrintType = DispatchPrintType

export default function DispatchPrintClient({ type }: { type: PrintType }) {
  const searchParams = useSearchParams()
  const locale = useLocale()
  const lang: PrintLang = locale === routing.defaultLocale ? 'zh' : 'en'
  const title = getDispatchPrintTitle(type, lang)
  const date = searchParams.get('date')
  const fromDate = searchParams.get('fromDate') ?? undefined
  const driverSlotId = searchParams.get('driverSlotId') ?? undefined
  const batchLabel = searchParams.get('batchLabel') ?? undefined
  const waveIdsRaw = searchParams.get('waveIds')
  const waveIds = waveIdsRaw ? waveIdsRaw.split(',') : undefined
  const variant = parsePickingVariant(searchParams.get('variant'))

  const [html, setHtml] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // driverSlotId / batchLabel 皆空 = 整日全部批次打印
    if (!date) {
      setError('缺少参数 date / Missing parameter: date')
      return
    }
    let cancelled = false
    fetchDispatchPrintHtml({ type, date, fromDate, driverSlotId, batchLabel, waveIds, variant, lang })
      .then(h => { if (!cancelled) setHtml(h) })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : '加载失败 / Loading failed') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, fromDate, driverSlotId, batchLabel, waveIdsRaw, type, variant, lang])

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial,sans-serif', color: '#dc2626' }}>
        {title} — 加载失败 / Loading failed: {error}
      </div>
    )
  }

  if (!html) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial,sans-serif', color: '#666' }}>
        正在准备 / Preparing {title} …
      </div>
    )
  }

  // 用 iframe srcDoc 渲染：通过 dangerouslySetInnerHTML 注入的 <script>（JsBarcode、
  // window.print）浏览器不会执行；iframe 会把它当完整文档解析，脚本正常运行。
  return (
    <iframe
      title={title}
      srcDoc={html}
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 'none' }}
    />
  )
}
