'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Filter, Plus } from 'lucide-react'
import { useReporting } from './ReportingContext'
import type { FilterSpec, DimensionMeta, MeasureMeta } from '@/lib/reports/types'

type Operator = FilterSpec['operator']

const OPERATOR_LABELS_ZH: Record<Operator, string> = {
  '=': '等于',
  '!=': '不等于',
  '>': '大于',
  '<': '小于',
  '>=': '大于等于',
  '<=': '小于等于',
  like: '包含',
  in: '属于',
  not_in: '不属于',
  between: '介于',
}

const OPERATOR_LABELS_EN: Record<Operator, string> = {
  '=': 'Equals',
  '!=': 'Not equals',
  '>': 'Greater than',
  '<': 'Less than',
  '>=': 'Greater or equal',
  '<=': 'Less or equal',
  like: 'Contains',
  in: 'In',
  not_in: 'Not in',
  between: 'Between',
}

// 少数枚举值(时段/支付方式)在 lib/reports/definitions.ts 里只配了中文 option label,
// 英文界面下按 value 做兜底翻译,不改数据源(避免影响其它已依赖中文 label 的地方)
const OPTION_VALUE_LABELS_EN: Record<string, string> = {
  am: 'AM',
  pm: 'PM',
  ONLINE: 'Online',
  CASH: 'Cash',
}

function operatorsForType(type: DimensionMeta['type'] | 'measure'): Operator[] {
  switch (type) {
    case 'string':
      return ['=', '!=', 'like', 'in', 'not_in']
    case 'enum':
      return ['=', '!=', 'in', 'not_in']
    case 'date':
    case 'datetime':
      return ['=', '!=', '>', '<', '>=', '<=', 'between']
    case 'number':
    case 'measure':
      return ['=', '!=', '>', '<', '>=', '<=', 'between']
    default:
      return ['=', '!=']
  }
}

export function FilterPanel() {
  const { state, dispatch } = useReporting()
  const [open, setOpen] = useState(false)
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const allFields: { field: string; label: string; type: DimensionMeta['type'] | 'measure'; options?: { value: string; label: string }[] }[] = [
    ...state.dimensionDefs.map(d => ({ field: d.field, label: isEn ? d.label : d.labelZh, type: d.type, options: d.options })),
    ...state.measureDefs.map(m => ({ field: m.field, label: isEn ? m.label : m.labelZh, type: 'measure' as const })),
  ]

  return (
    <Popover open={open} onOpenChange={(o) => setOpen(o)}>
      <PopoverTrigger className="inline-flex items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 h-8 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Filter className="h-3.5 w-3.5" />
        {isEn ? 'Filter' : '筛选'}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <AddFilterForm
          fields={allFields}
          onAdd={(filter) => {
            dispatch({ type: 'ADD_FILTER', filter })
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

interface AddFilterFormProps {
  fields: { field: string; label: string; type: DimensionMeta['type'] | 'measure'; options?: { value: string; label: string }[] }[]
  onAdd: (filter: FilterSpec) => void
}

function AddFilterForm({ fields, onAdd }: AddFilterFormProps) {
  const [selectedField, setSelectedField] = useState('')
  const [operator, setOperator] = useState<Operator>('=')
  const [value, setValue] = useState('')
  const [value2, setValue2] = useState('')
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const OPERATOR_LABELS = isEn ? OPERATOR_LABELS_EN : OPERATOR_LABELS_ZH
  const optionLabel = (o: { value: string; label: string }) =>
    isEn ? (OPTION_VALUE_LABELS_EN[o.value] ?? o.label) : o.label

  const fieldMeta = fields.find(f => f.field === selectedField)
  const operators = fieldMeta ? operatorsForType(fieldMeta.type) : ['=' as Operator]

  const handleFieldChange = (field: string | null) => {
    if (!field) return
    setSelectedField(field)
    setOperator('=')
    setValue('')
    setValue2('')
  }

  const handleSubmit = () => {
    if (!selectedField || !value) return

    let filterValue: FilterSpec['value']
    if (operator === 'between') {
      filterValue = [value, value2]
    } else if (operator === 'in' || operator === 'not_in') {
      filterValue = value.split(',').map(v => v.trim())
    } else if (fieldMeta?.type === 'number' || fieldMeta?.type === 'measure') {
      filterValue = Number(value)
    } else {
      filterValue = value
    }

    onAdd({ field: selectedField, operator, value: filterValue })
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-muted-foreground">{isEn ? 'Field' : '字段'}</label>
        <Select value={selectedField} onValueChange={handleFieldChange}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder={isEn ? 'Select field' : '选择字段'} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {fields.map(f => (
              <SelectItem key={f.field} value={f.field}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedField && (
        <div>
          <label className="text-xs text-muted-foreground">{isEn ? 'Operator' : '条件'}</label>
          <Select value={operator} onValueChange={(v) => { if (v) setOperator(v as Operator) }}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map(op => (
                <SelectItem key={op} value={op}>
                  {OPERATOR_LABELS[op]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {selectedField && (
        <div>
          <label className="text-xs text-muted-foreground">{isEn ? 'Value' : '值'}</label>
          {fieldMeta?.options && (operator === '=' || operator === '!=') ? (
            <Select value={value} onValueChange={(v) => { if (v) setValue(v) }}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={isEn ? 'Select value' : '选择值'} />
              </SelectTrigger>
              <SelectContent>
                {fieldMeta.options.map(o => (
                  <SelectItem key={o.value} value={o.value}>
                    {optionLabel(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex gap-2 mt-1">
              <Input
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={operator === 'in' || operator === 'not_in' ? (isEn ? 'Comma-separated values' : '逗号分隔多个值') :
                  (fieldMeta?.type === 'date' || fieldMeta?.type === 'datetime') ? 'YYYY-MM-DD' : (isEn ? 'Enter value' : '输入值')}
                type={fieldMeta?.type === 'number' || fieldMeta?.type === 'measure' ? 'number' : 'text'}
              />
              {operator === 'between' && (
                <>
                  <span className="self-center text-sm text-muted-foreground">~</span>
                  <Input
                    value={value2}
                    onChange={e => setValue2(e.target.value)}
                    placeholder={isEn ? 'End value' : '结束值'}
                    type={fieldMeta?.type === 'number' || fieldMeta?.type === 'measure' ? 'number' : 'text'}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      <Button size="sm" className="w-full" onClick={handleSubmit} disabled={!selectedField || !value}>
        <Plus className="h-3.5 w-3.5 mr-1" />
        {isEn ? 'Add Filter' : '添加筛选'}
      </Button>
    </div>
  )
}
