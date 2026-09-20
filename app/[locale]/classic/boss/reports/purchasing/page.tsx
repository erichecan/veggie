'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import {
  SearchSelectDropdown, searchPurchasableProductOptions, searchSupplierOptions, type SearchOption,
} from '@/components/boss/analytics-shared'
import SupplierMonthMatrix from './SupplierMonthMatrix'

/**
 * 采购分析（数据中心导航里的第二项，与「销售分析」并排）
 * ============================================================================
 * 20260920 改版：原来这里是通用透视表（ReportingProvider + PivotTable，度量/分组/筛选
 * 下拉那一套）。客户看的是现网 Odoo 的 Purchase Analysis，要求供应商在左、月份在上，
 * 并且**与销售分析长一个样** —— 两页在导航上挨着，一个 shadcn 方角一个紫色圆角，
 * 一眼就是两套系统。
 *
 * 通用透视引擎（lib/reports/* + components/reporting/*）**没有删**，
 * `boss/reports/sales` 与 `boss/reports/logistics` 仍在用它，直链可达；
 * 本页只是不再走那套 UI，数据仍然打同一个 `/api/reports/purchasing`。
 */
export default function PurchasingReportPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [supplierFilter, setSupplierFilter] = useState<SearchOption[]>([])
  const [productFilter, setProductFilter] = useState<SearchOption[]>([])

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
      </div>

      <SupplierMonthMatrix
        isEn={isEn}
        supplierIds={supplierFilter.map((s) => s.id)}
        productIds={productFilter.map((p) => p.id)}
      />
    </div>
  )
}
