'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DateInterval } from '@/lib/reports/types'

const INTERVAL_LABELS: Record<DateInterval, string> = {
  day: '日',
  week: '周',
  month: '月',
  quarter: '季',
  year: '年',
}

interface DateIntervalPickerProps {
  value: DateInterval
  intervals: DateInterval[]
  onChange: (value: DateInterval) => void
}

export function DateIntervalPicker({ value, intervals, onChange }: DateIntervalPickerProps) {
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
