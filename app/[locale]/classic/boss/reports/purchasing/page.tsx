'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  SearchSelectDropdown, searchPurchasableProductOptions, searchSupplierOptions, defaultRange, type SearchOption,
} from '@/components/boss/analytics-shared'
import { DatePicker } from '@/components/ui/date-picker'
import SupplierMonthMatrix from './SupplierMonthMatrix'
import PurchaseOrderDetailTable from './PurchaseOrderDetailTable'

const PURPLE = '#875A7B'
type ViewMode = 'summary' | 'detail'

/**
 * 采购分析（数据中心导航里的第二项，与「销售分析」并排）
 * ============================================================================
 * 20260920 改版：原来这里是通用透视表（ReportingProvider + PivotTable，度量/分组/筛选
 * 下拉那一套）。客户看的是现网 Odoo 的 Purchase Analysis，要求供应商在左、月份在上，
 * 并且**与销售分析长一个样** —— 两页在导航上挨着，一个 shadcn 方角一个紫色圆角，
 * 一眼就是两套系统。
 *
 * 通用透视引擎（lib/reports/* + components/reporting/*）**没有删**，
 * `boss/reports/logistics` 仍在用它，直链可达；
 * （`boss/reports/sales` 已于 20260920 整页改为重定向到 boss/sales-analysis，不再是它的使用者。）
 * 本页只是不再走那套 UI，数据仍然打同一个 `/api/reports/purchasing`。
 */
export default function PurchasingReportPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [supplierFilter, setSupplierFilter] = useState<SearchOption[]>([])
  const [productFilter, setProductFilter] = useState<SearchOption[]>([])
  // 20260922 客户要求加时间段选择器：原来是"从 N 个月前到今天"的滚动窗口(monthsBack)，
  // 现在换成显式 from/to，与 procurement-analysis / sales-analysis 同款交互。
  // 默认给 180 天，接近原来 6 个月的默认窗口。
  const [range, setRange] = useState(() => defaultRange(180))
  // 20260922 客户要加一张明细表(按采购单逐行：审批日期/发票参考号/系统发票号/供应商/数量/金额)，
  // 跟原来的供应商×月矩阵是两种看法，做成 tab 切换而不是硬塞进同一张表。
  const [view, setView] = useState<ViewMode>('summary')

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Purchase Analysis</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {isEn ? 'Odoo-style purchase analysis report' : 'Odoo 风格采购分析报表'}
          </p>
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-3 shadow-sm">
        <SearchSelectDropdown
          label={isEn ? 'Suppliers' : '供应商'}
          selected={supplierFilter}
          onChange={setSupplierFilter}
          fetchOptions={searchSupplierOptions}
          isEn={isEn}
        />
        <SearchSelectDropdown
          label={isEn ? 'Products' : '产品'}
          selected={productFilter}
          onChange={setProductFilter}
          fetchOptions={searchPurchasableProductOptions}
          isEn={isEn}
        />
        <div className="h-5 w-px bg-gray-200" />
        {/* 时间段 */}
        <div className="flex items-center gap-1.5 text-sm">
          <DatePicker value={range.from} onChange={(v) => setRange((r) => ({ ...r, from: v }))} className="border border-gray-200 rounded-lg px-2 py-1" />
          <span className="text-gray-400">→</span>
          <DatePicker value={range.to} onChange={(v) => setRange((r) => ({ ...r, to: v }))} className="border border-gray-200 rounded-lg px-2 py-1" />
        </div>
        <div className="h-5 w-px bg-gray-200" />
        {/* 视图：汇总(供应商×月矩阵) / 明细(按采购单逐行) */}
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
          {([
            ['summary', isEn ? 'Summary' : '汇总'],
            ['detail', isEn ? 'Detail' : '明细'],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className="px-3 py-1.5 text-sm transition-colors"
              style={view === v ? { background: PURPLE, color: 'white' } : { background: 'white', color: '#6b7280' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'summary' ? (
        <SupplierMonthMatrix
          isEn={isEn}
          supplierIds={supplierFilter.map((s) => s.id)}
          productIds={productFilter.map((p) => p.id)}
          from={range.from}
          to={range.to}
        />
      ) : (
        <PurchaseOrderDetailTable
          isEn={isEn}
          supplierIds={supplierFilter.map((s) => s.id)}
          productIds={productFilter.map((p) => p.id)}
          from={range.from}
          to={range.to}
        />
      )}
    </div>
  )
}
