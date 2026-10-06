/**
 * 客户导出列 —— 与列表页表格的列一一对应（决策 D-2：屏幕上有什么就导什么）。
 * 金额不带 € 符号（带了 Excel 整列当文本），状态/结算方式用屏幕上的说法。
 */
import type { ExportColumn } from '../types'

export interface CustomerExportRow {
  customerNo?: number | null
  individualOrCompany?: string | null
  mobile?: string | null
  street?: string | null
  street2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  name?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  vatNumber?: string | null
  paymentTerm?: string | null
  pricelistNames?: string | null
  priceType?: string | null
  creditLimit?: number | null
  isActive?: boolean | null
  salesman?: string | null
  sageAccount?: string | null
  commissionRate?: number | null
  commissionFixed?: number | null
  settlementCycle?: string | null
  externalId?: string | null
  notes?: string | null
  externalNote?: string | null
}

const PAYMENT_LABEL_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const PAYMENT_LABEL_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }
// 与列表页 Price Type 列保持一致：不分中英文界面，沿用下单页(place-order)的说法
const PRICE_TYPE_LABEL: Record<string, string> = { multi: 'Multi Price', default: 'Default Price', last: 'Last Purchase Price' }

export const CUSTOMER_EXPORT_COLUMNS: readonly ExportColumn<CustomerExportRow>[] = [
  { key: 'customerNo', header: '客户编号', headerEn: 'Customer No', get: r => r.customerNo ?? '' },
  { key: 'individualOrCompany', header: '个人/公司', headerEn: 'Contact Type', get: r => r.individualOrCompany ?? 'company' },
  { key: 'mobile', header: '手机', headerEn: 'Mobile', get: r => r.mobile ?? '' },
  { key: 'street', header: '街道', headerEn: 'Street', get: r => r.street ?? '' },
  { key: 'street2', header: '街道 2', headerEn: 'Street 2', get: r => r.street2 ?? '' },
  { key: 'city', header: '城市', headerEn: 'City', get: r => r.city ?? '' },
  { key: 'state', header: '州/省', headerEn: 'State', get: r => r.state ?? '' },
  { key: 'zip', header: '邮编', headerEn: 'ZIP', get: r => r.zip ?? '' },
  { key: 'country', header: '国家', headerEn: 'Country', get: r => r.country ?? '' },
  { key: 'name', header: '客户名称', headerEn: 'Customer Name', get: r => r.name ?? '' },
  { key: 'address', header: '地址', headerEn: 'Address', get: r => r.address ?? '' },
  { key: 'phone', header: '电话', headerEn: 'Phone', get: r => r.phone ?? '' },
  { key: 'email', header: '邮箱', headerEn: 'Email', get: r => r.email ?? '' },
  { key: 'vatNumber', header: '税号', headerEn: 'VAT Number', get: r => r.vatNumber ?? '' },
  {
    key: 'paymentTerm',
    header: '结算方式', headerEn: 'Payment Term',
    get: r => {
      const k = String(r.paymentTerm ?? '')
      return PAYMENT_LABEL_ZH[k] ?? k
    },
  },
  { key: 'pricelistNames', header: '价格表', headerEn: 'Pricelist', get: r => r.pricelistNames ?? '' },
  { key: 'priceType', header: 'Price Type', headerEn: 'Price Type', get: r => PRICE_TYPE_LABEL[String(r.priceType ?? 'multi')] ?? PRICE_TYPE_LABEL.multi },
  {
    // 屏幕上空值显示「无限额」，导出留空 —— 写成 0 会被当成"额度为零"
    key: 'creditLimit',
    header: '信用额度 (€)', headerEn: 'Credit Limit (€)',
    get: r => (r.creditLimit === null || r.creditLimit === undefined ? '' : Number(r.creditLimit).toFixed(2)),
  },
  { key: 'isActive', header: '状态', headerEn: 'Status', get: r => (r.isActive !== false ? '活跃' : '停用') },
  { key: 'salesman', header: '业务员', headerEn: 'Salesman', get: r => r.salesman ?? '' },
  // Sage Account：财务对账用的客户编号，loader 里已对纯 SALES 角色过滤掉该字段的值
  { key: 'sageAccount', header: 'Sage Account', headerEn: 'Sage Account', get: r => r.sageAccount ?? '' },
  {
    // 与详情页表单同一换算（DB 存 0-1 的小数，屏幕/导出都按百分比展示）
    key: 'commissionRate', header: '司机提成比例 (%)', headerEn: 'Commission Rate (%)',
    get: r => (r.commissionRate == null ? '' : (Number(r.commissionRate) * 100).toFixed(2)),
  },
  {
    key: 'commissionFixed', header: '司机固定提成 (€)', headerEn: 'Commission Fixed (€)',
    get: r => (r.commissionFixed == null ? '' : Number(r.commissionFixed).toFixed(2)),
  },
  { key: 'settlementCycle', header: '对账单周期', headerEn: 'Statement Cycle', get: r => r.settlementCycle ?? 'NONE' },
  { key: 'externalId', header: '外部单号', headerEn: 'External ID', get: r => r.externalId ?? '' },
  { key: 'notes', header: '内部备注', headerEn: 'Internal Notes', get: r => r.notes ?? '' },
  { key: 'externalNote', header: '客户可见备注', headerEn: 'External Note', get: r => r.externalNote ?? '' },
]

/** 英文界面下把结算方式/状态也换成英文说法 */
export const CUSTOMER_EXPORT_COLUMNS_EN: readonly ExportColumn<CustomerExportRow>[] =
  CUSTOMER_EXPORT_COLUMNS.map(c =>
    c.key === 'paymentTerm'
      ? { ...c, get: (r: CustomerExportRow) => PAYMENT_LABEL_EN[String(r.paymentTerm ?? '')] ?? String(r.paymentTerm ?? '') }
      : c.key === 'isActive'
        ? { ...c, get: (r: CustomerExportRow) => (r.isActive !== false ? 'Active' : 'Inactive') }
        : c,
  )
