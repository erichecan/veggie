/**
 * 可组合报表：销售 / 采购 / 物流 —— 端到端实证
 * ============================================================================
 * 台账 H2。验收三条：
 *   ① 销售与采购各至少一个页面接入透视
 *   ② 维度白名单可配置
 *   ③ 行列互换与下钻可用
 *
 * **先核实现状的结论写在这里**：清单说「透视引擎只接了毛利分析一处、采购侧完全没有
 * 可组合分析」——不准确。仓库里早有一整套 Odoo 式报表（`lib/reports/*` +
 * `components/reporting/*` + 三个页面 + `/api/reports/[type]` + 三张 SQL 视图），
 * 销售/采购/物流都在，行列互换也在。真正的缺口是：**没有任何导航入口指向它们**
 * （用户到不了 = 等于不存在），以及**下钻没做**。
 *
 * 所以本脚本验的是「这套东西真的能用」，而不是「代码在不在」。
 *
 * ⚠️ 只读（不写业务数据）。
 * 用法：npm run test:reports-pivot
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { buildDrillRequest } from '../../lib/reports/drilldown'
import { PURCHASING_DIMENSIONS } from '../../lib/reports/definitions'
import type { ReportRequest } from '../../lib/reports/types'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const SALES = process.env.SALES_EMAIL ?? 'sales@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)
const near = (a: number, b: number) => Math.abs(a - b) < 0.02

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: seedPassword(email) }),
  })
  const j = await r.json() as { token?: string }
  return j.token ?? null
}

interface ReportResp { rows?: Array<Record<string, unknown>>; totals?: Record<string, number>; total?: number; error?: string }

async function main() {
  const token = await login(OPERATOR)
  if (!token) { skip('登录', '运营账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const query = async (type: string, body: ReportRequest, headers = auth) => {
    const r = await fetch(`${BASE}/api/reports/${type}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({})) as ReportResp
    return { status: r.status, ...j }
  }

  // ── ① 三张报表都能出数（视图必须存在，全新库 db push 会漏建，见 D8）───────
  // ⛔ `pg_views.viewname` 的类型是 `name`，Neon 适配器反序列化不了（P2010
  // UnsupportedNativeDataType），整个脚本会在第一条断言就崩。必须 ::text 转一下，
  // 否则这个探针只能在 adapter-pg 的 .env.test 上跑，本机开发库一跑就炸。
  const views = await prisma.$queryRaw<Array<{ viewname: string }>>`
    SELECT viewname::text AS viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'veggie_%_report'`
  add('① 三张报表视图都存在（db push 只建表不建视图，全新库会漏）',
    views.length === 3, views.map(v => v.viewname).join(', ') || '⛔ 一张都没有')

  const sales = await query('sales', {
    rowDimensions: [{ field: 'product_name' }], measures: ['line_subtotal', 'ordered_qty'],
  })
  add('① 销售报表可组合出数', sales.status === 200 && (sales.rows?.length ?? 0) > 0,
    `HTTP ${sales.status} · ${sales.rows?.length ?? 0} 行 · 合计 €${num(sales.totals?.line_subtotal).toFixed(2)}`)

  const purchasing = await query('purchasing', {
    rowDimensions: [{ field: 'supplier_name' }], measures: ['subtotal_ex_tax', 'ordered_qty'],
  })
  add('① 采购报表可组合出数（清单说"采购侧完全没有"，实为已有）',
    purchasing.status === 200 && (purchasing.rows?.length ?? 0) > 0,
    `HTTP ${purchasing.status} · ${purchasing.rows?.length ?? 0} 行 · 合计 €${num(purchasing.totals?.subtotal_ex_tax).toFixed(2)}`)

  const logistics = await query('logistics', {
    rowDimensions: [{ field: 'driver_name' }], measures: ['total_payment', 'trip_count'],
  })
  add('① 物流报表可组合出数', logistics.status === 200 && (logistics.rows?.length ?? 0) > 0,
    `HTTP ${logistics.status} · ${logistics.rows?.length ?? 0} 行`)

  // ── ② 维度白名单：不在白名单里的字段必须被拒，且不能拼进 SQL ───────────────
  const bogusDim = await query('sales', { rowDimensions: [{ field: 'o.id; DROP TABLE "Order"' }], measures: ['line_subtotal'] })
  add('② 白名单外的维度被拒（400），SQL 注入无从下手',
    bogusDim.status === 400 && /无效维度/.test(bogusDim.error ?? ''),
    `HTTP ${bogusDim.status} · ${bogusDim.error ?? ''}`)
  const bogusMeasure = await query('sales', { rowDimensions: [{ field: 'product_name' }], measures: ['1=1'] })
  add('② 白名单外的度量被拒（400）', bogusMeasure.status === 400, `HTTP ${bogusMeasure.status} · ${bogusMeasure.error ?? ''}`)
  const bogusFilter = await query('sales', {
    rowDimensions: [{ field: 'product_name' }], measures: ['line_subtotal'],
    filters: [{ field: 'nonexistent_col', operator: '=', value: 'x' }],
  })
  add('② 白名单外的筛选字段被拒（400）', bogusFilter.status === 400, `HTTP ${bogusFilter.status}`)
  const bogusInterval = await query('sales', {
    rowDimensions: [{ field: 'product_name', interval: 'century' as never }], measures: ['line_subtotal'],
  })
  add('② 非法时间粒度不被接受', bogusInterval.status === 200 || bogusInterval.status === 400,
    `HTTP ${bogusInterval.status}（非日期维度带 interval 应被忽略或拒绝，不能 500）`)

  // ── ③ 行列互换：行列对调后总计不变，且格子转置后一一对应 ────────────────────
  const rowsFirst = await query('sales', {
    rowDimensions: [{ field: 'category_name' }], colDimensions: [{ field: 'time_of_day' }],
    measures: ['line_subtotal'],
  })
  const swapped = await query('sales', {
    rowDimensions: [{ field: 'time_of_day' }], colDimensions: [{ field: 'category_name' }],
    measures: ['line_subtotal'],
  })
  const totalA = num(rowsFirst.totals?.line_subtotal)
  const totalB = num(swapped.totals?.line_subtotal)
  add('③ 行列互换后总计不变', near(totalA, totalB) && totalA > 0,
    `€${totalA.toFixed(2)} vs €${totalB.toFixed(2)}`)

  // 逐格转置比对 —— 只比总计的话，"互换"就算完全没生效也照样通过
  const keyA = new Map<string, number>()
  for (const r of rowsFirst.rows ?? []) keyA.set(`${r.category_name}|${r.time_of_day}`, num(r.line_subtotal))
  let cellDiff = 0
  for (const r of swapped.rows ?? []) {
    const v = keyA.get(`${r.category_name}|${r.time_of_day}`)
    if (v === undefined || !near(v, num(r.line_subtotal))) cellDiff++
  }
  add('③ 行列互换后逐格转置一一对应（不只比总计）',
    cellDiff === 0 && (swapped.rows?.length ?? 0) > 0,
    `${swapped.rows?.length ?? 0} 格，其中对不上 ${cellDiff} 格`)

  // ── ③ 下钻：子行合计必须等于父行 ─────────────────────────────────────────
  const parentReq: ReportRequest = {
    rowDimensions: [{ field: 'supplier_name' }], colDimensions: [], measures: ['subtotal_ex_tax', 'ordered_qty'],
  }
  const parent = await query('purchasing', parentReq)
  const parentRow = (parent.rows ?? []).find(r => num(r.subtotal_ex_tax) > 0)
  if (!parentRow) {
    skip('③ 下钻', '采购报表里没有金额大于 0 的行可下钻')
  } else {
    const drillReq = buildDrillRequest({
      base: parentReq, row: parentRow, by: { field: 'product_name' },
    })
    add('③ 下钻请求可构造（行值能锁住）', !!drillReq,
      drillReq ? `锁 ${drillReq.filters?.length} 条筛选，按 product_name 分组` : '⛔ 构造失败')
    if (drillReq) {
      const child = await query('purchasing', drillReq)
      const childSum = (child.rows ?? []).reduce((s, r) => s + num(r.subtotal_ex_tax), 0)
      const childQty = (child.rows ?? []).reduce((s, r) => s + num(r.ordered_qty), 0)
      add('③ 下钻子行合计 == 父行（这条才证明"锁"是对的）',
        child.status === 200 && near(childSum, num(parentRow.subtotal_ex_tax)) && near(childQty, num(parentRow.ordered_qty)),
        `子 €${childSum.toFixed(2)} / ${childQty} vs 父 €${num(parentRow.subtotal_ex_tax).toFixed(2)} / ${num(parentRow.ordered_qty)} · ${child.rows?.length ?? 0} 个子行（${parentRow.supplier_name}）`)
      add('③ 下钻确实钻细了（子行数 ≥ 1 且按新维度分组）',
        (child.rows?.length ?? 0) >= 1 && (child.rows ?? []).every(r => 'product_name' in r),
        `${child.rows?.length ?? 0} 行，字段 ${Object.keys((child.rows ?? [])[0] ?? {}).join(',')}`)
    }
  }

  // 时间维度下钻：半开区间锁法必须不丢末日（between 会丢）
  const monthReq: ReportRequest = {
    rowDimensions: [{ field: 'confirmation_date', interval: 'month' }], colDimensions: [], measures: ['line_subtotal'],
  }
  const byMonth = await query('sales', monthReq)
  const monthRow = (byMonth.rows ?? []).find(r => num(r.line_subtotal) > 0)
  if (!monthRow) {
    skip('③ 时间维度下钻', '销售报表按月分组没有非零行')
  } else {
    const drillReq = buildDrillRequest({ base: monthReq, row: monthRow, by: { field: 'product_name' } })
    const child = drillReq ? await query('sales', drillReq) : null
    const childSum = (child?.rows ?? []).reduce((s, r) => s + num(r.line_subtotal), 0)
    add('③ 时间维度下钻不丢末日（>= 与 < 两条锁，不用 between）',
      !!child && child.status === 200 && near(childSum, num(monthRow.line_subtotal)),
      `子 €${childSum.toFixed(2)} vs 父 €${num(monthRow.line_subtotal).toFixed(2)}（${String(monthRow.confirmation_date_month).slice(0, 10)}）`)
  }

  // ── ④ 日期维度当**列**用：采购分析页（供应商 × 下单月份）靠的就是这条 ─────────
  // 20260920 修的 bug 就藏在这里：结果集里日期列叫 `order_date_month`（带粒度后缀），
  // 渲染层却按 `order_date` 去读，取到 undefined → 所有月份塌成同一个 key，
  // 而合并时是覆盖不是累加 → 只剩最后一个月的数字。接口一直是对的，所以这组断言
  // 既验接口、也把"多个时间桶必须各自成列且可相加"这条钉死，供渲染层比对。
  const flat = await query('purchasing', {
    rowDimensions: [{ field: 'supplier_name' }], measures: ['subtotal_ex_tax', 'ordered_qty'],
  })
  const byMonthCols = await query('purchasing', {
    rowDimensions: [{ field: 'supplier_name' }],
    colDimensions: [{ field: 'order_date', interval: 'month' }],
    measures: ['subtotal_ex_tax', 'ordered_qty'],
    limit: 5000,
  })
  const monthKeys = new Set((byMonthCols.rows ?? []).map(r => String(r.order_date_month ?? '')))
  add('④ 日期维度作列时，结果集带 order_date_month 且不止一个桶',
    byMonthCols.status === 200 && monthKeys.size > 1
      && (byMonthCols.rows ?? []).every(r => 'order_date_month' in r),
    `${monthKeys.size} 个月桶 · ${byMonthCols.rows?.length ?? 0} 行 · 字段 ${Object.keys((byMonthCols.rows ?? [])[0] ?? {}).join(',')}`)

  const colSum = (byMonthCols.rows ?? []).reduce((acc, r) => acc + num(r.subtotal_ex_tax), 0)
  add('④ 各月相加 == 不分月的合计（证明是累加而非覆盖）',
    near(colSum, num(flat.totals?.subtotal_ex_tax)) && colSum > 0,
    `分月相加 €${colSum.toFixed(2)} vs 合计 €${num(flat.totals?.subtotal_ex_tax).toFixed(2)}`)

  // 采购分析页的展开：锁住一家供应商，按商品再分一次组，逐月必须与父行对齐
  const pivotParent = (flat.rows ?? []).find(r => num(r.subtotal_ex_tax) > 0)
  if (!pivotParent) {
    skip('④ 供应商 × 月 的展开', '采购报表里没有金额大于 0 的供应商')
  } else {
    const sName = String(pivotParent.supplier_name)
    const parentByMonth = new Map<string, number>()
    for (const r of byMonthCols.rows ?? []) {
      if (String(r.supplier_name) !== sName) continue
      parentByMonth.set(String(r.order_date_month ?? ''), num(r.subtotal_ex_tax))
    }
    const kids = await query('purchasing', {
      rowDimensions: [{ field: 'product_name' }],
      colDimensions: [{ field: 'order_date', interval: 'month' }],
      measures: ['subtotal_ex_tax', 'ordered_qty'],
      filters: [{ field: 'supplier_name', operator: '=', value: sName }],
      limit: 5000,
    })
    const kidByMonth = new Map<string, number>()
    for (const r of kids.rows ?? []) {
      const k = String(r.order_date_month ?? '')
      kidByMonth.set(k, (kidByMonth.get(k) ?? 0) + num(r.subtotal_ex_tax))
    }
    let offBy = 0
    for (const [k, v] of parentByMonth) if (!near(v, kidByMonth.get(k) ?? 0)) offBy++
    add('④ 展开到商品后，逐月与供应商行逐格相等',
      kids.status === 200 && parentByMonth.size > 0 && offBy === 0,
      `${sName} · ${parentByMonth.size} 个月，对不上 ${offBy} 个`)
  }

  // ── ④ 采购单状态白名单必须与 schema 对齐 ─────────────────────────────────
  // 采购分析页默认只统计 CONFIRMED 及之后；筛选面板的可选项来自 PURCHASING_DIMENSIONS。
  // 两边对不上的表现是"某些单怎么都查不到"，界面上看不出少了选项。
  const dbStatuses = await prisma.$queryRaw<Array<{ po_status: string }>>`
    SELECT DISTINCT po_status FROM veggie_purchasing_report WHERE po_status IS NOT NULL`
  const declared = new Set((PURCHASING_DIMENSIONS.po_status.options ?? []).map(o => o.value))
  const missing = dbStatuses.map(r => r.po_status).filter(v => !declared.has(v))
  add('④ 采购单状态选项覆盖库里实际出现的所有状态',
    missing.length === 0,
    missing.length ? `⛔ 白名单里缺 ${missing.join(', ')}` : `库里 ${dbStatuses.length} 种，白名单 ${declared.size} 种，无遗漏`)

  // ── ④ 币种守卫：采购报表的金额是**原币**，页面却一律标 € ──────────────────
  // veggie_purchasing_report 的 subtotal_ex_tax 映射的是 PurchaseOrderLine.subtotalExTax，
  // 即原币值；schema 里写明下游应读 subtotalExTaxEur（= 原币 × exchangeRate）。
  // 20260920 实测生产库 35 张非取消采购单全是 EUR、两个字段零差异，所以当前
  // 「原币直接当欧元显示并相加」不会给出错数字 —— 但这是"今天恰好成立"。
  // 这条断言就是那个铃：哪天真的进了外币采购单，它先红，而不是让采购分析页
  // 静默把不同币种加在一起。届时的修法是视图层换列（连带口径决策），不是改 UI。
  const fx = await prisma.$queryRaw<Array<{ currency: string; pos: bigint }>>`
    SELECT currency, COUNT(*) AS pos FROM "PurchaseOrder"
    WHERE status::text <> 'CANCELLED' GROUP BY currency`
  const nonEur = fx.filter(r => r.currency !== 'EUR')
  add('④ 采购单全部是 EUR（采购报表把原币当欧元显示的前提）',
    nonEur.length === 0,
    nonEur.length
      ? `⛔ 出现外币采购单：${nonEur.map(r => `${r.currency}×${Number(r.pos)}`).join(', ')}。` +
        `采购分析页会把它们当欧元直接相加，必须改视图读 *Eur 列`
      : `${fx.map(r => `${r.currency}×${Number(r.pos)}`).join(', ')}`)

  // ── 角色可见性 ──────────────────────────────────────────────────────────
  // ⚠️ 这里断言的是**实际行为**，不是路由里那张 ROLE_REPORT_ACCESS 表写了什么。
  // 实测：`sales` 与 `driver` 角色一个 analytics.* 权限都没有，请求在 gate 层就 403，
  // 根本走不到那张表 —— 表里给它们的条目是装饰性配置（台账 H2 / 待决策 13）。
  const salesToken = await login(SALES)
  if (!salesToken) skip('角色可见性（SALES）', '销售账号登录失败（限流？）')
  else {
    const h = { Authorization: `Bearer ${salesToken}`, 'Content-Type': 'application/json' }
    const ok = await query('sales', { rowDimensions: [{ field: 'product_name' }], measures: ['line_subtotal'] }, h)
    const pur = await query('purchasing', { rowDimensions: [{ field: 'supplier_name' }], measures: ['subtotal_ex_tax'] }, h)
    // 种子里的 sales@veggie.com 兼任 OPERATOR（台账周期 2 记过：19 个 SALES 全兼任），
    // 所以它看得到采购报表 —— 这是账号配置的结果，不是权限漏洞
    add('销售账号（兼任 OPERATOR）能看报表', ok.status === 200,
      `sales ${ok.status} / purchasing ${pur.status}（该账号 roles=[OPERATOR,SALES]，故能看全部）`)
  }
  const driverToken = await login(DRIVER)
  if (!driverToken) skip('角色可见性（DRIVER）', '司机账号登录失败（限流？）')
  else {
    const h = { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' }
    const log = await query('logistics', { rowDimensions: [{ field: 'driver_name' }], measures: ['trip_count'] }, h)
    const sal = await query('sales', { rowDimensions: [{ field: 'product_name' }], measures: ['line_subtotal'] }, h)
    add('司机看不了销售报表（该拦的拦住了）', sal.status === 403, `sales ${sal.status}`)
    add('⚠️ 司机也看不了物流报表 —— 路由里 DRIVER:[logistics] 是够不着的死配置',
      log.status === 403,
      `logistics ${log.status}：gate 要 analytics.report.generate，而 driver 角色无任何 analytics 权限。` +
      `本轮不擅自补权限（扩大数据可见面属产品决策），已在代码注释与待决策 13 登记`)
  }

  // ── 空请求的错误必须说人话，不能 500 ─────────────────────────────────────
  const noDim = await query('sales', { rowDimensions: [], measures: ['line_subtotal'] })
  add('没有维度时返回 400 而不是 500', noDim.status === 400, `HTTP ${noDim.status} · ${noDim.error ?? ''}`)
  const noMeasure = await query('sales', { rowDimensions: [{ field: 'product_name' }], measures: [] })
  add('没有度量时返回 400 而不是 500', noMeasure.status === 400, `HTTP ${noMeasure.status}`)
  const badType = await fetch(`${BASE}/api/reports/nonexistent`, {
    method: 'POST', headers: auth, body: JSON.stringify({ rowDimensions: [{ field: 'x' }], measures: ['y'] }),
  })
  add('无效报表类型返回 400', badType.status === 400, `HTTP ${badType.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 可组合报表 · 销售/采购/物流（H2）────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(46)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
