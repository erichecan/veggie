/**
 * 订单导出 CSV 的行整形——把 Order[] 摊成"订单汇总"一行/单、"产品明细"一行/商品行。
 * 供订单列表页导出(app/api/orders/export-csv)和日销售中心导出
 * (app/api/print/day-wise-report-csv)共用，未税/税额/总额口径统一走
 * computeOrderTotals（跟「日报（按客户）」PDF 完全同源，见 lib/order-totals.ts）。
 */
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { computeOrderTotals } from '@/lib/order-totals'
import { money } from './csv'
import type { Order } from '@/lib/types'

const STATUS_LABEL_ZH: Record<string, string> = {
  PENDING: '待处理',
  CONFIRMED: '已确认',
  WAVE_ASSIGNED: '司机分配结束',
  IN_DELIVERY: '配送中',
  COMPLETED: '已完成',
  LOCKED: '拣货中',
  CANCELLED: '已取消',
}

// deliveryDate 视调用方是否过 serializeApi 而定，可能是 ISO 字符串(orders-list 导出)
// 或原始 Prisma Date 对象(day-wise-report 导出直接吃 loader 的 raw 结果，未 serialize)。
function dateOnly(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  return (iso instanceof Date ? iso.toISOString() : iso).slice(0, 10)
}

/**
 * order.code 是自然键（部分历史/导入订单为空）。CSV 是给会计做批量核对用的，"订单号"列必须
 * 唯一——不能像 day-wise-report PDF 那样退回 order.id.slice(0,8)：cuid2 按创建时间靠前编码，
 * 同批导入/同一天下的订单前 8 位大概率相同，实测 158 条真实订单里就撞出 6 组不同订单同码。
 * 这里退回完整 id，牺牲一点可读性换取"同一列里的值真的能当唯一键用"。
 */
function orderCode(order: { code?: string | null; id: string }): string {
  return order.code ?? order.id
}

export const ORDER_SUMMARY_HEADERS = ['订单号', '交货日期', '状态', '客户', '销售员', '司机', '未税金额', '税额', '含税总额']

/** 订单列表页导出用：order.salesUser 需已 include，否则销售员列留空 */
export function buildOrderSummaryRows(orders: (Order & { salesUser?: { name: string } | null })[]): (string | number)[][] {
  return orders.map(order => {
    const { untaxed, tax, total } = computeOrderTotals(order)
    return [
      orderCode(order),
      dateOnly(order.deliveryDate),
      STATUS_LABEL_ZH[order.status] ?? order.status,
      order.restaurantName,
      order.salesUser?.name ?? '',
      formatDriverSlotFromOrder(order) || '',
      money(untaxed),
      money(tax),
      money(total),
    ]
  })
}

export const ORDER_DETAIL_HEADERS = ['订单号', '交货日期', '客户', '产品', '数量', '单价', '税率(%)', '金额']

export function buildOrderDetailRows(orders: Order[]): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const order of orders) {
    const code = orderCode(order)
    const date = dateOnly(order.deliveryDate)
    for (const l of order.lines ?? []) {
      const rate = Number(l.taxRate ?? 0)
      const ratePct = rate > 1 ? rate : rate * 100
      rows.push([
        code,
        date,
        order.restaurantName,
        l.productName,
        l.orderedQty,
        money(Number(l.unitPrice)),
        money(ratePct),
        money(Number(l.subtotal)),
      ])
    }
  }
  return rows
}
