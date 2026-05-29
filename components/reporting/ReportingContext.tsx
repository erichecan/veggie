'use client'

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
  type Dispatch,
} from 'react'
import { apiGet, apiPost } from '@/lib/api'
import type {
  ReportType,
  ReportRequest,
  ReportResponse,
  DimensionMeta,
  MeasureMeta,
  DimensionSpec,
  FilterSpec,
} from '@/lib/reports/types'

export type ViewMode = 'pivot'

export interface ReportingState {
  reportType: ReportType
  viewMode: ViewMode
  rowDimensions: DimensionSpec[]
  colDimensions: DimensionSpec[]
  activeMeasures: string[]
  filters: FilterSpec[]
  orderBy: { field: string; direction: 'asc' | 'desc' }[]
  limit: number
  offset: number

  dimensionDefs: DimensionMeta[]
  measureDefs: MeasureMeta[]
  metadataLoaded: boolean

  rows: Record<string, unknown>[]
  totals: Record<string, number>
  total: number
  loading: boolean
  error: string | null
}

export type ReportingAction =
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'SET_ROW_DIMENSIONS'; dims: DimensionSpec[] }
  | { type: 'SET_COL_DIMENSIONS'; dims: DimensionSpec[] }
  | { type: 'ADD_ROW_DIMENSION'; dim: DimensionSpec }
  | { type: 'REMOVE_ROW_DIMENSION'; field: string }
  | { type: 'ADD_COL_DIMENSION'; dim: DimensionSpec }
  | { type: 'REMOVE_COL_DIMENSION'; field: string }
  | { type: 'FLIP_AXES' }
  | { type: 'SET_MEASURES'; measures: string[] }
  | { type: 'TOGGLE_MEASURE'; measure: string }
  | { type: 'SET_FILTERS'; filters: FilterSpec[] }
  | { type: 'ADD_FILTER'; filter: FilterSpec }
  | { type: 'REMOVE_FILTER'; index: number }
  | { type: 'SET_ORDER_BY'; orderBy: { field: string; direction: 'asc' | 'desc' }[] }
  | { type: 'SET_OFFSET'; offset: number }
  | { type: 'METADATA_LOADED'; dimensions: DimensionMeta[]; measures: MeasureMeta[] }
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; data: ReportResponse }
  | { type: 'FETCH_ERROR'; error: string }

function reducer(state: ReportingState, action: ReportingAction): ReportingState {
  switch (action.type) {
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.mode }
    case 'SET_ROW_DIMENSIONS':
      return { ...state, rowDimensions: action.dims, offset: 0 }
    case 'SET_COL_DIMENSIONS':
      return { ...state, colDimensions: action.dims, offset: 0 }
    case 'ADD_ROW_DIMENSION':
      return { ...state, rowDimensions: [...state.rowDimensions, action.dim], offset: 0 }
    case 'REMOVE_ROW_DIMENSION':
      return { ...state, rowDimensions: state.rowDimensions.filter(d => d.field !== action.field), offset: 0 }
    case 'ADD_COL_DIMENSION':
      return { ...state, colDimensions: [...state.colDimensions, action.dim], offset: 0 }
    case 'REMOVE_COL_DIMENSION':
      return { ...state, colDimensions: state.colDimensions.filter(d => d.field !== action.field), offset: 0 }
    case 'FLIP_AXES':
      return { ...state, rowDimensions: state.colDimensions, colDimensions: state.rowDimensions, offset: 0 }
    case 'SET_MEASURES':
      return { ...state, activeMeasures: action.measures, offset: 0 }
    case 'TOGGLE_MEASURE': {
      const has = state.activeMeasures.includes(action.measure)
      const next = has
        ? state.activeMeasures.filter(m => m !== action.measure)
        : [...state.activeMeasures, action.measure]
      if (next.length === 0) return state
      return { ...state, activeMeasures: next, offset: 0 }
    }
    case 'SET_FILTERS':
      return { ...state, filters: action.filters, offset: 0 }
    case 'ADD_FILTER':
      return { ...state, filters: [...state.filters, action.filter], offset: 0 }
    case 'REMOVE_FILTER':
      return { ...state, filters: state.filters.filter((_, i) => i !== action.index), offset: 0 }
    case 'SET_ORDER_BY':
      return { ...state, orderBy: action.orderBy, offset: 0 }
    case 'SET_OFFSET':
      return { ...state, offset: action.offset }
    case 'METADATA_LOADED':
      return { ...state, dimensionDefs: action.dimensions, measureDefs: action.measures, metadataLoaded: true }
    case 'FETCH_START':
      return { ...state, loading: true, error: null }
    case 'FETCH_SUCCESS':
      return {
        ...state,
        loading: false,
        rows: action.data.rows,
        totals: action.data.totals,
        total: action.data.total,
      }
    case 'FETCH_ERROR':
      return { ...state, loading: false, error: action.error }
    default:
      return state
  }
}

interface ReportingContextValue {
  state: ReportingState
  dispatch: Dispatch<ReportingAction>
  fetchData: () => Promise<void>
}

const ReportingContext = createContext<ReportingContextValue | null>(null)

export function useReporting() {
  const ctx = useContext(ReportingContext)
  if (!ctx) throw new Error('useReporting must be used within ReportingProvider')
  return ctx
}

interface ProviderProps {
  reportType: ReportType
  children: ReactNode
}

export function ReportingProvider({ reportType, children }: ProviderProps) {
  const initialState: ReportingState = {
    reportType,
    viewMode: 'pivot',
    rowDimensions: [],
    colDimensions: [],
    activeMeasures: [],
    filters: [],
    orderBy: [],
    limit: 200,
    offset: 0,
    dimensionDefs: [],
    measureDefs: [],
    metadataLoaded: false,
    rows: [],
    totals: {},
    total: 0,
    loading: false,
    error: null,
  }

  const [state, dispatch] = useReducer(reducer, initialState)

  const fetchData = useCallback(async () => {
    if (state.activeMeasures.length === 0) return
    if (state.rowDimensions.length === 0 && state.colDimensions.length === 0) return

    dispatch({ type: 'FETCH_START' })
    try {
      const body: ReportRequest = {
        rowDimensions: state.rowDimensions,
        colDimensions: state.colDimensions.length > 0 ? state.colDimensions : undefined,
        measures: state.activeMeasures,
        filters: state.filters.length > 0 ? state.filters : undefined,
        orderBy: state.orderBy.length > 0 ? state.orderBy : undefined,
        limit: state.limit,
        offset: state.offset,
      }
      const data = await apiPost<ReportResponse>(`/api/reports/${reportType}`, body)
      dispatch({ type: 'FETCH_SUCCESS', data })
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', error: err instanceof Error ? err.message : '查询失败' })
    }
  }, [
    reportType,
    state.rowDimensions,
    state.colDimensions,
    state.activeMeasures,
    state.filters,
    state.orderBy,
    state.limit,
    state.offset,
  ])

  useEffect(() => {
    apiGet<{ dimensions: DimensionMeta[]; measures: MeasureMeta[] }>(
      `/api/reports/${reportType}/metadata`
    ).then(meta => {
      dispatch({ type: 'METADATA_LOADED', dimensions: meta.dimensions, measures: meta.measures })
    })
  }, [reportType])

  useEffect(() => {
    if (state.metadataLoaded) {
      fetchData()
    }
  }, [state.metadataLoaded, fetchData])

  return (
    <ReportingContext.Provider value={{ state, dispatch, fetchData }}>
      {children}
    </ReportingContext.Provider>
  )
}
