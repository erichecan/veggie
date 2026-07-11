'use client'

import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { useReporting } from './ReportingContext'
import { PivotTable } from './PivotTable'
import { BarChart3, Rows3 } from 'lucide-react'

export function ReportView() {
  const { state } = useReporting()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  if (state.loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        {isEn ? 'Loading...' : '加载中...'}
      </div>
    )
  }

  if (state.activeMeasures.length === 0 || (state.rowDimensions.length === 0 && state.colDimensions.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
        <div className="flex items-center gap-2 text-muted-foreground/60">
          <Rows3 className="h-8 w-8" />
          <BarChart3 className="h-8 w-8" />
        </div>
        <p className="text-sm">{isEn ? 'Select dimensions and measures to start analyzing' : '请选择维度和度量来开始分析'}</p>
        <p className="text-xs text-muted-foreground/60">
          {isEn
            ? 'Choose a "Row" or "Column" dimension in the toolbar above, plus at least one measure'
            : '在上方工具栏中选择「行」或「列」维度，以及至少一个度量指标'}
        </p>
      </div>
    )
  }

  return <PivotTable />
}
