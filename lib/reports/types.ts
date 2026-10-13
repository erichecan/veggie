export type DateInterval = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface DimensionSpec {
  field: string
  interval?: DateInterval
}

export interface FilterSpec {
  field: string
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'not_in' | 'between' | 'like'
  value: string | number | string[] | [string, string]
}

export interface ReportRequest {
  rowDimensions: DimensionSpec[]
  colDimensions?: DimensionSpec[]
  measures: string[]
  filters?: FilterSpec[]
  /** Optional OR group. Every filter here may match; the group is ANDed with filters. */
  orFilters?: FilterSpec[]
  /** Multiple OR groups; each group is ANDed with the other filters and groups. */
  orFilterGroups?: FilterSpec[][]
  limit?: number
  offset?: number
  orderBy?: { field: string; direction: 'asc' | 'desc' }[]
}

export interface ReportResponse {
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  metadata?: {
    dimensions: DimensionMeta[]
    measures: MeasureMeta[]
  }
  total: number
  limit: number
  offset: number
}

export interface DimensionMeta {
  field: string
  label: string
  labelZh: string
  type: 'string' | 'date' | 'datetime' | 'number' | 'enum'
  options?: { value: string; label: string }[]
  dateIntervals?: DateInterval[]
}

export interface MeasureMeta {
  field: string
  label: string
  labelZh: string
  aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max'
  format: 'currency' | 'decimal' | 'integer' | 'percentage' | 'weight'
}

export type ReportType = 'sales' | 'purchasing' | 'logistics'
