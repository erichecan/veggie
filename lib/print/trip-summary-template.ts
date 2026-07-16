/**
 * Trip 汇总单 — 批次级订单清单（一个司机一个时段送哪些订单），按客户名字母序排列
 *
 * 表格：序号 | 发票号 | 客户名称 | 城市 | 地址 | 电话 | 备注 | 金额
 * 每个订单单独一行，同一客户当天多笔订单不合并（客户要求两单都要看到，20260715）。
 * 服务端无头 Chromium 渲染 PDF 不认识中文字体（Alpine 镜像未装 CJK 字体），
 * 此模板的可见文案一律用英文，避免打印出乱码方块（20260715）。
 */

import {
  type TripPrintData,
  escapeHtml,
  formatTripDriverLabel,
} from './trip-common'
import { formatDateOnly, formatDateTime } from '@/lib/format-date'
import { fmtMoney } from '@/lib/format-money'

export function generateTripSummaryHtml(data: TripPrintData): string {
  const { trip, orders, customers } = data

  const driverStr = formatTripDriverLabel(trip)

  const deliveryDates = orders
    .map(o => o.deliveryDate)
    .filter(Boolean) as string[]
  const startDate = deliveryDates.length > 0
    ? deliveryDates.reduce((a, b) => (a < b ? a : b))
    : trip.departTime

  // 每单单独一行，不按客户合并；同一客户多笔订单都要展示（客户要求，20260715）
  const rowList = orders
    .map(o => ({
      order: o,
      name: customers.get(o.customerId)?.name ?? o.customerName ?? '',
      customer: customers.get(o.customerId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.order.code?.localeCompare(b.order.code ?? '') || 0)

  // 客户详情（地址/电话/备注）直接做在表格列里，不再单独列一个详情区块
  const nameRowsHtml = rowList.map((r, i) => {
    const { order, customer } = r
    const addr = customer ? [customer.street, customer.street2, customer.city, customer.zip].filter(Boolean).join(', ') : ''
    const city = customer?.city ?? ''
    const phone = customer?.phone ?? ''
    const note = customer?.externalNote ?? ''
    return `
    <tr>
      <td class="col-seq">${i + 1}</td>
      <td>${escapeHtml(order.invoiceNo ?? '')}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(city)}</td>
      <td>${escapeHtml(addr)}</td>
      <td>${escapeHtml(phone)}</td>
      <td>${escapeHtml(note)}</td>
      <td class="num">€ ${fmtMoney(order.totalAmount)}</td>
    </tr>`
  }).join('')

  const now = formatDateTime(new Date().toISOString())

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Johnstone Bros Delivery Summary</title>
<script src="/vendor/JsBarcode.all.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; background: #fff; }
  body { padding: 18px 24px; }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .page-header .left { font-size: 10px; color: #333; }
  .page-header .center { text-align: center; font-size: 14px; font-weight: 700; }
  .page-header .right { font-size: 10px; color: #333; text-align: right; }

  .filter-row {
    display: flex;
    gap: 24px;
    margin-bottom: 8px;
    font-size: 11px;
    border-bottom: 1px solid #000;
    padding-bottom: 4px;
  }
  .filter-row .item { white-space: nowrap; }
  .filter-row .label { font-weight: 700; }

  table.summary {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    margin-top: 4px;
  }
  table.summary th {
    background: #e8e8e8;
    border: 1px solid #999;
    padding: 4px 8px;
    text-align: left;
    font-weight: 700;
    font-size: 11px;
  }
  table.summary th.num { text-align: right; }
  table.summary td.num { text-align: right; white-space: nowrap; }
  table.summary th.col-seq { text-align: center; width: 40px; }
  table.summary td {
    border: 1px solid #999;
    padding: 3px 8px;
    vertical-align: middle;
  }
  table.summary td.col-seq { text-align: center; color: #666; }

  .stats-row {
    margin-top: 10px;
    display: flex;
    gap: 24px;
    font-size: 11px;
    padding: 6px 8px;
    background: #f5f5f5;
    border-radius: 3px;
  }
  .stats-row .num { font-weight: 700; }

  @media print {
    body { padding: 0; }
    @page { margin: 12mm 10mm; }
  }
</style>
</head>
<body>
  <div class="page-header">
    <div class="left">Print at: ${now}</div>
    <div class="center">Johnstone Bros Delivery Summary</div>
    <div class="right">1 / 1</div>
  </div>

  <div class="filter-row">
    <div class="item"><span class="label">Delivery Date : </span>${formatDateOnly(startDate)}</div>
    <div class="item"><span class="label">Driver : </span>${escapeHtml(driverStr)}</div>
  </div>

  <table class="summary">
    <thead>
      <tr>
        <th class="col-seq">#</th>
        <th>Invoice No.</th>
        <th>Customer</th>
        <th>City</th>
        <th>Address</th>
        <th>Phone</th>
        <th>Note</th>
        <th class="num">Net Amount</th>
      </tr>
    </thead>
    <tbody>
      ${nameRowsHtml || '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">No orders</td></tr>'}
    </tbody>
  </table>

  <div class="stats-row">
    <span>Customers: <span class="num">${new Set(orders.map(o => o.customerId)).size}</span></span>
    <span>Orders: <span class="num">${orders.length}</span></span>
  </div>

<script>
  window.print();
<\/script>
</body>
</html>`
}
