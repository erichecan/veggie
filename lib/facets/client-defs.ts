'use client'
/**
 * 客户端过滤类列表页的分面维度定义（key/label + 从行里取可匹配文本）。
 *
 * 这类页面全量加载后在前端过滤，所以维度定义不需要拆成「前端 key/label」+「后端子句」
 * 两份 —— 一份 ClientFacetDef 同时供下拉和过滤使用，是这 14 个页面相对服务端类的优势。
 *
 * 维度取舍依据 docs/20260802-facet-dimension-data-readiness.md 的填充率体检，
 * 全空列一律不作为维度。
 */
import { localizeClientFacetDefs, type ClientFacetDef } from '../facet-client'
import type { Invoice } from '../types'

/** 从 defs 派生下拉用的 key/label 列表（含 all 通配项），按 isEn 选中英文名。 */
export function fieldsOf<T>(defs: ClientFacetDef<T>[], isEn = false): { key: string; label: string }[] {
  return localizeClientFacetDefs(defs, isEn)
}

// ── 发票 ────────────────────────────────────────────────────────────────────
export const INVOICE_FACET_DEFS: ClientFacetDef<Invoice>[] = [
  { key: 'name',     label: '发票号', labelEn: 'Invoice #',    values: r => [r.name] },
  { key: 'customer', label: '客户',   labelEn: 'Customer',     values: r => [r.customerName] },
  { key: 'status',   label: '状态',   labelEn: 'Status',       values: r => [r.status] },
  { key: 'terms',    label: '结算方式', labelEn: 'Payment Term', values: r => [r.paymentTerms] },
]

// 后续页面按同样形状往下加：贷记单 / 供应商账单 / 用户 / 价格表 / 行程 …
// 注意贷记单的 notes、createdBy 两列体检为全空，不要作为维度。
