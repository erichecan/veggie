'use client'
import { useState } from 'react'
import { apiGet } from '@/lib/api'
import type { SaleUomOption, SaleUomPriceMode } from '@/lib/sale-uom'

/**
 * 多单位销售(20260714 试点)：懒加载并缓存某商品配置的可售单位选项，供加商品/切单位下拉共用。
 *
 * 三个订单页原先各自复制了一份逐字相同的 fetch+缓存实现，20260904 收口到这一处——
 * 详见 lib/sale-uom.ts 顶部同一批改动的说明。
 *
 * 返回 Promise 而不是 fire-and-forget：调用方（加行前）要在插入行之前就知道基础单位
 * 是否 active，不能像纯展示那样"先渲染、数据晚点到"。
 */
export function useSaleUomOptions(isEn: boolean) {
  const [saleUomOptions, setSaleUomOptions] = useState<Record<string, SaleUomOption[]>>({})

  function ensureSaleUomOptions(productId: string): Promise<SaleUomOption[]> {
    if (!productId) return Promise.resolve([])
    if (productId in saleUomOptions) return Promise.resolve(saleUomOptions[productId] ?? [])
    setSaleUomOptions(prev => ({ ...prev, [productId]: [] })) // 占位，避免并发重复请求
    return apiGet<Array<{
      uomId: string
      isDefault: boolean
      factor: number | string | null
      priceOverride: number | null
      active: boolean
      priceMode?: SaleUomPriceMode
      priceDiscountPct?: number | string | null
      priceSurcharge?: number | string | null
      uom: { name: string; nameZh?: string | null }
    }>>(`/api/products/${productId}/sale-uoms`)
      .then(rows => {
        // factor 取 ProductSaleUom.factor（这个商品自己的箱规），不是全局 uom.factor。
        // ⛔ 不能只留 active=true 的行——基础单位那行也可能被关掉(20260901)，下拉框
        // 要知道它 active=false 才能把它从选项里剔除；筛活跃的活儿挪到渲染处做。
        const opts: SaleUomOption[] = rows.map(r => ({
          uomId: r.uomId,
          uomName: isEn ? r.uom.name : (r.uom.nameZh ?? r.uom.name),
          isDefault: r.isDefault,
          factor: Number(r.factor ?? 1) || 1,
          priceOverride: r.priceOverride,
          priceMode: r.priceMode ?? 'AUTO',
          priceDiscountPct: r.priceDiscountPct != null ? Number(r.priceDiscountPct) : 0,
          priceSurcharge: r.priceSurcharge != null ? Number(r.priceSurcharge) : 0,
          active: r.active,
        }))
        setSaleUomOptions(prev => ({ ...prev, [productId]: opts }))
        return opts
      })
      .catch(() => {
        setSaleUomOptions(prev => ({ ...prev, [productId]: [] }))
        return []
      })
  }

  return { saleUomOptions, ensureSaleUomOptions }
}
