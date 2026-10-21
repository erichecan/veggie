/**
 * 未核销回单清单 PDF —— 20261021 核销管理（客户：没回来核销的单要打印日期、单号、上午/下午、司机、金额，
 * 可按日期或按司机分组；打印要符合整体打印模板风格）。
 * 版式沿用内部报表那一套（lib/print/day-wise-report-template.ts 的 CSS + 公司页头 + 徽章 + 打印时间，
 * 页脚「筛选摘要 - Page X/Y」由 renderHtmlToPdf 统一加），服务端渲染，server-safe。
 */
import { DOCUMENT_HEADER_CSS, documentHeader } from './document-header'
import { CSS as REPORT_CSS } from './day-wise-report-template'
import { escapeHtml, formatPrintTimestamp } from './trip-common'
import { eur } from '@/lib/format-money'
import type { ReturnRow } from '@/lib/accounting/returns'

export type ReturnsGroupBy = 'date' | 'driver'

const STATUS_TEXT: Record<string, string> = { PENDING: '未回', ISSUE: '有问题', RETURNED: '已核销' }
const TIME_TEXT: Record<string, string> = { am: '上午', pm: '下午' }

const EXTRA_CSS = `
tr.ret-row td { padding:1.6mm 3mm; font-size:9pt; border-bottom:1px solid #eee; }
tr.ret-row.issue td { background:#fff7ed; }
td.mono { font-family: 'Courier New', monospace; }
th, td.nw, td.mono { white-space:nowrap; }
th.st, td.st { width:28mm; white-space:normal; }
th.cu, td.cu { width:40mm; white-space:normal; }
td.days-late { color:#b91c1c; font-weight:bold; }
.report-meta b { color:#333; }
`

function dmy(day: string | null): string {
  if (!day) return '—'
  const [y, m, d] = day.split('-')
  return `${d}/${m}/${y}`
}

export function buildReturnsReportHtml(rows: ReturnRow[], groupBy: ReturnsGroupBy, meta: string): string {
  const groups = new Map<string, ReturnRow[]>()
  for (const r of rows) {
    const key = groupBy === 'driver' ? (r.driver || '未分配司机') : (r.deliveryDate ?? '')
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b))
  const inGroup = (list: ReturnRow[]) => [...list].sort((a, b) => groupBy === 'driver'
    ? (a.deliveryDate ?? '').localeCompare(b.deliveryDate ?? '') || a.timeOfDay.localeCompare(b.timeOfDay) || (a.code ?? '').localeCompare(b.code ?? '')
    : a.timeOfDay.localeCompare(b.timeOfDay) || a.driver.localeCompare(b.driver) || (a.code ?? '').localeCompare(b.code ?? ''))
  const cashOf = (list: ReturnRow[]) => list.filter(r => r.paymentMethod.toUpperCase() === 'CASH').reduce((s, r) => s + r.amount, 0)
  const sum = (list: ReturnRow[]) => list.reduce((s, r) => s + r.amount, 0)

  const body = orderedKeys.map(key => {
    const list = inGroup(groups.get(key)!)
    const cash = cashOf(list)
    const title = groupBy === 'driver' ? `司机：${escapeHtml(key)}` : `送货日期：${dmy(key || null)}`
    return `
      <tr class="date-row"><td colspan="9">${title}</td></tr>
      ${list.map(r => `<tr class="ret-row${r.returnStatus === 'ISSUE' ? ' issue' : ''}">
        <td class="nw">${dmy(r.deliveryDate)}</td>
        <td class="mono">${escapeHtml(r.code ?? r.id.slice(-8))}</td>
        <td class="cu">${escapeHtml(r.restaurantName)}</td>
        <td class="c nw">${TIME_TEXT[r.timeOfDay] ?? '—'}</td>
        <td class="nw">${escapeHtml(r.driver || '未分配')}</td>
        <td class="c nw">${r.paymentMethod.toUpperCase() === 'CASH' ? '现付' : '转账'}</td>
        <td class="r nw">${eur(r.amount)}</td>
        <td class="st">${STATUS_TEXT[r.returnStatus] ?? r.returnStatus}${r.returnIssueNote ? `：${escapeHtml(r.returnIssueNote)}` : ''}</td>
        <td class="r nw${r.daysOut >= 2 ? ' days-late' : ''}">${r.daysOut} 天</td>
      </tr>`).join('')}
      <tr class="date-total">
        <td colspan="6">小计 ${list.length} 张${cash > 0 ? `（其中现付 ${eur(cash)}）` : ''}</td>
        <td class="r">${eur(sum(list))}</td><td colspan="2"></td>
      </tr>`
  }).join('')

  const table = rows.length === 0
    ? '<div style="padding:10mm;text-align:center;color:#15803d;font-size:11pt;">✅ 没有未核销的回单</div>'
    : `<table>
      <thead><tr>
        <th>送货日期</th><th>单号</th><th class="cu">客户</th><th class="c">上午/下午</th><th>司机</th>
        <th class="c">付款方式</th><th class="r">含税金额</th><th class="st">状态</th><th class="r">已送出</th>
      </tr></thead>
      <tbody>
        ${body}
        <tr class="grand-total">
          <td colspan="6">总计 ${rows.length} 张${cashOf(rows) > 0 ? `（其中现付 ${eur(cashOf(rows))}）` : ''}</td>
          <td class="r">${eur(sum(rows))}</td><td colspan="2"></td>
        </tr>
      </tbody>
    </table>`

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"/>
<title>未核销回单清单</title>
<style>${REPORT_CSS}${DOCUMENT_HEADER_CSS}${EXTRA_CSS}
</style>
</head>
<body>
<div class="page">
  ${documentHeader('reportReturns')}
  <div><div class="printed-at">打印时间： ${formatPrintTimestamp()}</div></div>
  <div class="report-title">未核销回单清单（按${groupBy === 'driver' ? '司机' : '送货日期'}分组）</div>
  <div class="report-meta">${meta}</div>
  ${table}
</div>
</body>
</html>`
}
