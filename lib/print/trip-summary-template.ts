/**
 * Trip 汇总单 — 批次级客户清单（一个司机一个时段送哪些客户），按客户名字母序去重排列
 *
 * 表格：序号 | 客户名称 | 地址 | 电话 | 备注（去重，不重复列同一客户的多笔订单；
 * 客户详情直接做在表格列里，不再单独放一个详情区块，方便司机一行看全）
 */

import {
  type TripPrintData,
  escapeHtml,
} from './trip-common'
import { docBadge } from './doc-badge'
import { formatDateOnly, formatDateTime } from '@/lib/format-date'

export function generateTripSummaryHtml(data: TripPrintData): string {
  const { trip, orders, customers } = data

  const teamParts = [
    trip.timeSlot?.toLowerCase() ?? '',
    trip.name ?? '',
    trip.driverName ?? '',
  ].filter(Boolean)
  const teamStr = teamParts.join(' ')

  const deliveryDates = orders
    .map(o => o.deliveryDate)
    .filter(Boolean) as string[]
  const startDate = deliveryDates.length > 0
    ? deliveryDates.reduce((a, b) => (a < b ? a : b))
    : trip.departTime
  const endDate = deliveryDates.length > 0
    ? deliveryDates.reduce((a, b) => (a > b ? a : b))
    : trip.departTime

  // 按 customerId 去重(同一客户当天多笔订单只列一次)，按客户名字母序排列
  const customerIds = [...new Set(orders.map(o => o.customerId))]
  const customerList = customerIds
    .map(id => ({
      id,
      name: customers.get(id)?.name ?? orders.find(o => o.customerId === id)?.customerName ?? '',
      customer: customers.get(id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  // 客户详情（地址/电话/备注）直接做在表格列里，不再单独列一个详情区块
  const nameRowsHtml = customerList.map((c, i) => {
    const cust = c.customer
    const addr = cust ? [cust.street, cust.street2, cust.city, cust.zip].filter(Boolean).join(', ') : ''
    const phone = cust?.phone ?? ''
    const note = cust?.externalNote ?? ''
    return `
    <tr>
      <td class="col-seq">${i + 1}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(addr)}</td>
      <td>${escapeHtml(phone)}</td>
      <td>${escapeHtml(note)}</td>
    </tr>`
  }).join('')

  const now = formatDateTime(new Date().toISOString())

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Summary</title>
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
  <div style="margin-bottom:3mm;">${docBadge('deliverySummary')}</div>
  <div class="page-header">
    <div class="left">${now}</div>
    <div class="center">Johnstone Fruit &amp; Veg Ltd — 汇总单</div>
    <div class="right">1 / 1</div>
  </div>

  <div class="filter-row">
    <div class="item"><span class="label">Start Date : </span>${formatDateOnly(startDate)}</div>
    <div class="item"><span class="label">End Date : </span>${formatDateOnly(endDate)}</div>
    <div class="item"><span class="label">Sales Team : </span>${escapeHtml(teamStr)}</div>
  </div>

  <table class="summary">
    <thead>
      <tr>
        <th class="col-seq">#</th>
        <th>Customer</th>
        <th>Address</th>
        <th>Phone</th>
        <th>Note</th>
      </tr>
    </thead>
    <tbody>
      ${nameRowsHtml || '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px">No orders</td></tr>'}
    </tbody>
  </table>

  <div class="stats-row">
    <span>客户数：<span class="num">${customerList.length}</span></span>
    <span>订单数：<span class="num">${orders.length}</span></span>
  </div>

<script>
  window.print();
<\/script>
</body>
</html>`
}
