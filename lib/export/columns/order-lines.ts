/**
 * 销售单「全字段导出」列（订单 + 明细行，一行一个商品，与
 * lib/export/columns/purchase-orders.ts 同一模式）。
 *
 * 跟 lib/export/columns/orders.ts（订单/报价单列表页用，一单一行）是两份
 * 独立的列定义 —— 那份被 quotations 页共用，改成行级会让它的导出行数跟着
 * 订单行数膨胀；这里单独开一个实体只给销售单列表页的「导出（全字段）」用。
 */
import { money } from '../csv'
import type { ExportColumn } from '../types'

const STATUS_LABEL_ZH: Record<string, string> = {
  PENDING: '待处理', CONFIRMED: '已确认', WAVE_ASSIGNED: '司机分配结束',
  IN_DELIVERY: '配送中', COMPLETED: '已完成', LOCKED: '拣货中', CANCELLED: '已取消',
}
const STATUS_LABEL_EN: Record<string, string> = {
  PENDING: 'Pending', CONFIRMED: 'Confirmed', WAVE_ASSIGNED: 'Driver Assigned',
  IN_DELIVERY: 'In Delivery', COMPLETED: 'Completed', LOCKED: 'Picking', CANCELLED: 'Cancelled',
}
const PAYMENT_LABEL_ZH: Record<string, string> = { ONLINE: '线上支付', CASH: '现金' }
const PAYMENT_LABEL_EN: Record<string, string> = { ONLINE: 'Online', CASH: 'Cash' }

export interface OrderLineExportRow {
  id: string
  code?: string | null
  status: string
  restaurantName?: string | null
  salesmanName?: string | null
  driverLabel?: string | null
  quotationDate?: string | Date | null
  deliveryDate?: string | Date | null
  paymentMethod?: string | null
  internalNote?: string | null
  externalNote?: string | null
  untaxed?: number | null
  tax?: number | null
  total?: number | null
  lineCount?: number | null
  productName?: string | null
  spec?: string | null
  note?: string | null
  uomName?: string | null
  quantity?: number | null
  unitPrice?: number | null
  taxRate?: number | null
  isGift?: boolean | null
  lineSubtotal?: number | null
}

function dateOnly(v: string | Date | null | undefined): string {
  if (!v) return ''
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10)
}

const orderCode = (r: OrderLineExportRow) => r.code ?? r.id

export function orderLineExportColumns(isEn: boolean): readonly ExportColumn<OrderLineExportRow>[] {
  const status = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  const payment = isEn ? PAYMENT_LABEL_EN : PAYMENT_LABEL_ZH
  return [
    { key: 'code', header: '订单号', headerEn: 'Order No', get: orderCode },
    { key: 'status', header: '状态', headerEn: 'Status', get: r => status[r.status] ?? r.status },
    { key: 'restaurantName', header: '客户', headerEn: 'Customer', get: r => r.restaurantName ?? '' },
    { key: 'salesmanName', header: '销售员', headerEn: 'Salesman', get: r => r.salesmanName ?? '' },
    { key: 'driverLabel', header: '司机', headerEn: 'Driver', get: r => r.driverLabel ?? '' },
    { key: 'quotationDate', header: '下单日期', headerEn: 'Order Date', get: r => dateOnly(r.quotationDate) },
    { key: 'deliveryDate', header: '交货日期', headerEn: 'Delivery Date', get: r => dateOnly(r.deliveryDate) },
    { key: 'paymentMethod', header: '付款方式', headerEn: 'Payment Method', get: r => payment[r.paymentMethod ?? ''] ?? (r.paymentMethod ?? '') },
    { key: 'productName', header: '商品名称', headerEn: 'Product Name', get: r => r.productName ?? '' },
    { key: 'spec', header: '规格', headerEn: 'Spec', get: r => r.spec ?? '' },
    { key: 'uomName', header: '单位', headerEn: 'UoM', get: r => r.uomName ?? '' },
    { key: 'quantity', header: '数量', headerEn: 'Quantity', get: r => r.quantity ?? '' },
    { key: 'unitPrice', header: '单价', headerEn: 'Unit Price', get: r => money(r.unitPrice ?? 0) },
    { key: 'taxRate', header: '税率 (%)', headerEn: 'Tax Rate (%)', get: r => r.taxRate ?? '' },
    { key: 'isGift', header: '赠品', headerEn: 'Gift', get: r => (r.isGift ? (isEn ? 'Yes' : '是') : '') },
    { key: 'lineSubtotal', header: '行金额', headerEn: 'Line Amount', get: r => money(r.lineSubtotal ?? 0) },
    { key: 'note', header: '行备注', headerEn: 'Line Note', get: r => r.note ?? '' },
    { key: 'internalNote', header: '内部备注', headerEn: 'Internal Note', get: r => r.internalNote ?? '' },
    { key: 'externalNote', header: '外部备注', headerEn: 'External Note', get: r => r.externalNote ?? '' },
    { key: 'untaxed', header: '订单未税金额 (€)', headerEn: 'Order Untaxed (€)', get: r => money(r.untaxed ?? 0) },
    { key: 'tax', header: '订单税额 (€)', headerEn: 'Order Tax (€)', get: r => money(r.tax ?? 0) },
    { key: 'total', header: '订单含税总额 (€)', headerEn: 'Order Total (€)', get: r => money(r.total ?? 0) },
    { key: 'lineCount', header: '订单行数', headerEn: 'Line Count', get: r => r.lineCount ?? '' },
  ]
}
