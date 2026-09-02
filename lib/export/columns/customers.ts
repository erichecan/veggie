/**
 * 客户导出列 —— 与列表页表格的列一一对应（决策 D-2：屏幕上有什么就导什么）。
 * 金额不带 € 符号（带了 Excel 整列当文本），状态/结算方式用屏幕上的说法。
 */
import type { ExportColumn } from '../types'

export interface CustomerExportRow {
  name?: string | null
  address?: string | null
  vatNumber?: string | null
  paymentTerm?: string | null
  pricelistNames?: string | null
  priceType?: string | null
  creditLimit?: number | null
  isActive?: boolean | null
  salesman?: string | null
}

const PAYMENT_LABEL_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABEL_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }
// 与列表页 Price Type 列保持一致：不分中英文界面，沿用下单页(place-order)的说法
const PRICE_TYPE_LABEL: Record<string, string> = { multi: 'Multi Price', default: 'Default Price', last: 'Last Purchase Price' }

export const CUSTOMER_EXPORT_COLUMNS: readonly ExportColumn<CustomerExportRow>[] = [
  { header: '客户名称', headerEn: 'Customer Name', get: r => r.name ?? '' },
  { header: '地址', headerEn: 'Address', get: r => r.address ?? '' },
  { header: '税号', headerEn: 'VAT Number', get: r => r.vatNumber ?? '' },
  {
    header: '结算方式', headerEn: 'Payment Term',
    get: r => {
      const k = String(r.paymentTerm ?? '')
      return PAYMENT_LABEL_ZH[k] ?? k
    },
  },
  { header: '价格表', headerEn: 'Pricelist', get: r => r.pricelistNames ?? '' },
  { header: 'Price Type', headerEn: 'Price Type', get: r => PRICE_TYPE_LABEL[String(r.priceType ?? 'multi')] ?? PRICE_TYPE_LABEL.multi },
  {
    // 屏幕上空值显示「无限额」，导出留空 —— 写成 0 会被当成"额度为零"
    header: '信用额度 (€)', headerEn: 'Credit Limit (€)',
    get: r => (r.creditLimit === null || r.creditLimit === undefined ? '' : Number(r.creditLimit).toFixed(2)),
  },
  { header: '状态', headerEn: 'Status', get: r => (r.isActive !== false ? '活跃' : '停用') },
  { header: '业务员', headerEn: 'Salesman', get: r => r.salesman ?? '' },
]

/** 英文界面下把结算方式/状态也换成英文说法 */
export const CUSTOMER_EXPORT_COLUMNS_EN: readonly ExportColumn<CustomerExportRow>[] =
  CUSTOMER_EXPORT_COLUMNS.map(c =>
    c.header === '结算方式'
      ? { ...c, get: (r: CustomerExportRow) => PAYMENT_LABEL_EN[String(r.paymentTerm ?? '')] ?? String(r.paymentTerm ?? '') }
      : c.header === '状态'
        ? { ...c, get: (r: CustomerExportRow) => (r.isActive !== false ? 'Active' : 'Inactive') }
        : c,
  )
