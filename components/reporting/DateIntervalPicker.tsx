'use client'

import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DateInterval } from '@/lib/reports/types'

const INTERVAL_LABELS_ZH: Record<DateInterval, string> = {
  day: '日',
  week: '周',
  month: '月',
  quarter: '季',
  year: '年',
}

const INTERVAL_LABELS_EN: Record<DateInterval, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
}

interface DateIntervalPickerProps {
  value: DateInterval
  intervals: DateInterval[]
  onChange: (value: DateInterval) => void
}

export function DateIntervalPicker({ value, intervals, onChange }: DateIntervalPickerProps) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const INTERVAL_LABELS = isEn ? INTERVAL_LABELS_EN : INTERVAL_LABELS_ZH

  return (
    <Select value={value} onValueChange={v => onChange(v as DateInterval)}>
      <SelectTrigger className="h-5 w-auto min-w-0 border-none bg-transparent px-1 text-xs font-medium shadow-none focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {intervals.map(iv => (
          <SelectItem key={iv} value={iv} className="text-xs">
            {INTERVAL_LABELS[iv]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
