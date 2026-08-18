/**
 * 订单/报价单导出列（Order 实体，报价单只是它的一个状态视图）。
 *
 * 口径与既有的 app/api/orders/export-csv 一致 —— 未税/税额/总额都走
 * computeOrderTotals（与日报 PDF 同源，见 lib/order-totals.ts），
 * 不在这里另算一遍。
 */
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { computeOrderTotals } from '@/lib/order-totals'
import { money } from '../csv'
import type { ExportColumn } from '../types'
import type { Order } from '@/lib/types'

const STATUS_LABEL_ZH: Record<string, string> = {
  PENDING: '待处理', CONFIRMED: '已确认', WAVE_ASSIGNED: '司机分配结束',
  IN_DELIVERY: '配送中', COMPLETED: '已完成', LOCKED: '拣货中', CANCELLED: '已取消',
}
const STATUS_LABEL_EN: Record<string, string> = {
  PENDING: 'Pending', CONFIRMED: 'Confirmed', WAVE_ASSIGNED: 'Driver Assigned',
  IN_DELIVERY: 'In Delivery', COMPLETED: 'Completed', LOCKED: 'Picking', CANCELLED: 'Cancelled',
}

export type OrderExportRow = Order & { salesUser?: { name: string } | null }

function dateOnly(v: string | Date | null | undefined): string {
  if (!v) return ''
  return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10)
}

/**
 * order.code 是自然键，部分历史/导入订单为空。CSV 要能当唯一键用，所以退回完整 id
 * 而不是 id 前 8 位 —— cuid2 按创建时间靠前编码，同批导入的订单前 8 位大概率相同
 * （实测 158 条真实订单撞出 6 组同码）。
 */
const orderCode = (o: OrderExportRow) => o.code ?? o.id

export function orderExportColumns(isEn: boolean): readonly ExportColumn<OrderExportRow>[] {
  const status = isEn ? STATUS_LABEL_EN : STATUS_LABEL_ZH
  return [
    { header: '订单号', headerEn: 'Order No', get: orderCode },
    { header: '交货日期', headerEn: 'Delivery Date', get: o => dateOnly(o.deliveryDate) },
    { header: '下单日期', headerEn: 'Order Date', get: o => dateOnly(o.quotationDate) },
    { header: '状态', headerEn: 'Status', get: o => status[o.status] ?? o.status },
    { header: '客户', headerEn: 'Customer', get: o => o.restaurantName ?? '' },
    { header: '销售员', headerEn: 'Salesman', get: o => o.salesUser?.name ?? '' },
    { header: '司机', headerEn: 'Driver', get: o => formatDriverSlotFromOrder(o) || '' },
    { header: '未税金额 (€)', headerEn: 'Untaxed (€)', get: o => money(computeOrderTotals(o).untaxed) },
    { header: '税额 (€)', headerEn: 'Tax (€)', get: o => money(computeOrderTotals(o).tax) },
    { header: '含税总额 (€)', headerEn: 'Total (€)', get: o => money(computeOrderTotals(o).total) },
  ]
}
