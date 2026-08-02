/**
 * M08 财务管理中心
 *   ① 客户结算 ② 供应商结算 ③ 收付款管理 ④ 成本核算
 *   ⑤-⑨ 财务报表：销售毛利分析表 / 应收应付汇总表 / 利润表 / 资产负债表 / 费用分析表
 */
import { defineCheck, api, grepCode, grepMatrix, findFiles, prisma } from '../harness'

const BOSS_ANALYTICS = 'app/\\[locale\\]/classic/boss/analytics'

/** 报表类判定共用：页面在不在、API 通不通 */
async function reportProbe(pageDir: string, apiPath: string | null) {
  const pages = findFiles(`"app/[locale]/classic/boss/analytics/${pageDir}"`, 'page.tsx')
  const apiRes = apiPath ? await api(apiPath) : null
  return { pages, apiRes }
}

defineCheck({
  id: 'M08-01',
  module: '08',
  title: '客户结算（多种结算方式 / 自动对账单 / 预付 / 在线支付）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const terms = await prisma.customer.groupBy({ by: ['paymentTerm'], _count: true })
    evidence.push(`客户结算方式分布: ${terms.map(t => `${t.paymentTerm ?? 'null'}=${t._count}`).join(' ')}`)

    const stmts = await prisma.statement.count()
    evidence.push(`Statement 对账单: ${stmts} 张`)

    const r = await api('/api/statements')
    evidence.push(r.brief)

    // 自动触发 vs 手动生成
    const cron = findFiles('app/api/cron', 'route.ts').map(p => p.replace('app/api/cron/', '').replace('/route.ts', ''))
    evidence.push(`cron 定时任务: ${cron.join(', ') || '无'}`)
    const autoStmt = grepMatrix(['日结', 'dailySettle', 'autoStatement', '自动生成对账单'], 'app lib')
    evidence.push(`结算周期自动触发命中: ${JSON.stringify(autoStmt)}`)

    // 预付款 / 在线支付
    const pay = grepMatrix(['prepay', '预付', 'stripe', 'paypal', 'payment.*gateway', 'ONLINE'], 'app lib prisma/schema.prisma')
    evidence.push(`预付/在线支付命中: ${JSON.stringify(pay)}`)

    return {
      verdict: 'partial' as const,
      gap: '按客户生成对账单已实现（Statement ' + stmts + ' 张），周结/月结的口径也在客户档案里；' +
        '但没有日结/周结/月结的自动触发（无对应 cron 任务），' +
        '预付款无独立模型，PaymentMethod.ONLINE 只是个标签、未接任何真实支付网关',
      evidence,
    }
  },
})

defineCheck({
  id: 'M08-02',
  module: '08',
  title: '供应商结算（应付账款 / 按采购单入库单自动对账 / 分批付款）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const bills = await prisma.vendorBill.count()
    evidence.push(`VendorBill 供应商账单: ${bills} 条`)

    const autoFromPo = grepCode('vendor-bill-from-po|buildVendorBillFromPo', { roots: 'lib app/api', max: 3 })
    evidence.push(...autoFromPo.map(l => `按 PO 自动生成账单: ${l.slice(0, 130)}`))

    const partial = grepMatrix(['分批付款', 'partialPayment', 'paidAmount', 'installment'], 'app lib prisma/schema.prisma')
    evidence.push(`分批付款命中: ${JSON.stringify(partial)}`)

    // 与入库单核销
    const reconcile = grepMatrix(['核销', 'reconcil', 'matchReceipt', 'goodsReceiptId'], 'app/api lib prisma/schema.prisma')
    evidence.push(`入库单核销命中: ${JSON.stringify(reconcile)}`)

    const hasAuto = autoFromPo.length > 0
    return {
      verdict: 'partial' as const,
      gap: hasAuto
        ? `账单可由采购单自动生成（lib/vendor-bill-from-po.ts），分批付款字段在；` +
          `但与入库单(GoodsReceipt)之间没有自动核销——收了多少货 vs 该付多少钱要人工比对`
        : '供应商账单需手动录入',
      evidence,
    }
  },
})

defineCheck({
  id: 'M08-03',
  module: '08',
  title: '收付款管理（销售收款 / 采购付款 / 其他收支 / 银行账户与流水）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const payments = await prisma.payment.count()
    const invoices = await prisma.invoice.count()
    evidence.push(`Payment 收款记录 ${payments} 条 / Invoice ${invoices} 张`)

    const r = await api('/api/payments')
    evidence.push(r.brief)

    const bank = grepMatrix(['bankAccount', '银行账户', 'bankStatement', '流水'], 'app lib prisma/schema.prisma')
    evidence.push(`银行账户/流水模型命中: ${JSON.stringify(bank)}`)

    const misc = grepMatrix(['其他收支', 'otherIncome', 'otherExpense', 'miscExpense'], 'app lib prisma/schema.prisma')
    evidence.push(`其他收支命中: ${JSON.stringify(misc)}`)

    return {
      verdict: 'partial' as const,
      gap: `收款模型(Payment)与接口在，但生产库里 Payment ${payments} 条——` +
        `收款侧从未真正落过数据；「其他收入/支出」无模块、银行账户与流水无数据模型`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M08-04',
  module: '08',
  title: '成本核算（移动加权平均 / FIFO 计价 / 自动算销售成本与毛利）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const kw = grepMatrix(
      ['movingAverage', '移动加权', '加权平均', 'costMethod', 'standardCost', 'avgCost'],
      'app lib prisma/schema.prisma',
    )
    evidence.push(`计价方法关键词命中: ${JSON.stringify(kw)}`)

    // Lot 上有没有成本，StockMove 出库时有没有结转成本
    const lotCost = grepCode('unitCost', { roots: 'prisma/schema.prisma', max: 6 })
    evidence.push(...lotCost.map(l => `schema 成本字段: ${l.trim().slice(0, 110)}`))

    const lotsWithCost = await prisma.lot.count({ where: { unitCost: { not: null } } })
    const lotsAll = await prisma.lot.count()
    evidence.push(`带成本的批次: ${lotsWithCost}/${lotsAll}`)

    // 毛利是怎么算出来的
    const margin = grepCode('cost', { roots: 'lib/analytics/metrics.ts lib/analytics/margin.ts', max: 5 })
    evidence.push(...margin.map(l => `毛利成本口径: ${l.slice(0, 120)}`))

    return {
      verdict: 'partial' as const,
      gap: `批次上有 unitCost（${lotsWithCost}/${lotsAll} 已回填），毛利分析能算；` +
        `但没有系统性的出入库计价引擎——移动加权平均/标准成本等 costMethod 配置项零命中，` +
        `出库不做成本结转`,
      evidence,
    }
  },
})

// ── ⑤-⑨ 五张报表 ────────────────────────────────────────────────────────────

defineCheck({
  id: 'M08-05',
  module: '08',
  title: '财务报表 — 销售毛利分析表',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    const { pages, apiRes } = await reportProbe('margin', '/api/analytics/margin?days=30')
    evidence.push(`页面: ${pages.join(', ') || '无'}`)
    evidence.push(`接口: ${apiRes!.brief}`)
    const pivot = grepCode('colBy|PivotView', { roots: 'app lib components', max: 3 })
    evidence.push(...pivot.map(l => `透视能力: ${l.slice(0, 120)}`))
    return pages.length > 0 && apiRes!.status === 200
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: '页面或接口不可用', evidence }
  },
})

defineCheck({
  id: 'M08-06',
  module: '08',
  title: '财务报表 — 应收应付汇总表',
  prev: 'partial',
  async run() {
    const evidence: string[] = []
    const ar = await reportProbe('ar-aging', '/api/analytics/ar-aging')
    evidence.push(`应收账龄 页面: ${ar.pages.join(', ') || '无'} / 接口: ${ar.apiRes!.brief}`)

    const ap = await reportProbe('ap-aging', '/api/analytics/ap-aging')
    evidence.push(`应付账龄 页面: ${ap.pages.join(', ') || '无'} / 接口: ${ap.apiRes!.brief}`)

    // 导航里有入口吗？入口指向的页面存在吗？
    const nav = grepCode('ap-aging', { roots: 'app', max: 3 })
    evidence.push(...nav.map(l => `导航入口: ${l.slice(0, 130)}`))

    const apOk = ap.pages.length > 0 && ap.apiRes!.status === 200
    if (apOk) {
      return {
        verdict: 'done' as const,
        gap: '0729 时应付账龄只有导航入口、页面与 API 都不存在（点进去 404）；' +
          '20260802 已补齐，与应收共用同一套账龄阈值(AGING_BUCKETS)因而可直接对读。' +
          '注：当前 25 张供应商账单全是 DRAFT 未过账，账龄表暂为空，页面已把这一点写在提示条里',
        evidence,
      }
    }
    return {
      verdict: 'partial' as const,
      gap: '应收账龄已实现；**应付账龄只有导航入口、页面和 API 都不存在**（boss/layout.tsx 里的' +
        ' /classic/boss/analytics/ap-aging 是死链，点进去 404）',
      evidence,
    }
  },
})

defineCheck({
  id: 'M08-07',
  module: '08',
  title: '财务报表 — 利润表',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const { pages, apiRes } = await reportProbe('income-statement', '/api/analytics/income-statement')
    evidence.push(`页面: ${pages.join(', ') || '不存在'} / 接口: ${apiRes!.brief}`)

    const nav = grepCode('income-statement|利润表', { roots: 'app lib components', max: 4 })
    evidence.push(...nav.map(l => `命中: ${l.slice(0, 130)}`))

    const ledger = await prisma.journalEntry.count()
    const lines = await prisma.journalEntryLine.count()
    const accounts = await prisma.account.count()
    evidence.push(`底层复式记账：Account ${accounts} 个 / JournalEntry ${ledger} 条 / Line ${lines} 行`)

    // 死链入口已于 20260802 摘除，判定仍是 missing（功能确实没有），但不再叠加"点进去 404"这条缺陷
    const navStillLinks = nav.some(l => l.includes('href') && l.includes('income-statement'))
    evidence.push(`导航仍挂着入口: ${navStillLinks ? '是（死链）' : '否（20260802 已摘除）'}`)
    return {
      verdict: 'missing' as const,
      gap: `利润表页面与 API 均不存在（接口返回 ${apiRes!.status}）。` +
        (navStillLinks ? '而 boss/layout.tsx 仍挂着导航入口 → **点进去是 404 死链**。' : '导航入口已于 20260802 摘除，不再是死链。') +
        `不补的根因是**费用没有数据来源**：无「其他收支」录入模块，` +
        `Account ${accounts} 个但 JournalEntry ${ledger} 条 / Line ${lines} 行——复式记账是空壳。` +
        `硬做只能产出一张缺全部运营费用的表。恢复条件已写进 layout.tsx 注释`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M08-08',
  module: '08',
  title: '财务报表 — 资产负债表',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const kw = grepMatrix(['资产负债', 'balanceSheet', 'balance-sheet', '所有者权益'], 'app lib components')
    evidence.push(`关键词命中: ${JSON.stringify(kw)}`)
    const r = await api('/api/analytics/balance-sheet')
    evidence.push(`接口: ${r.brief}`)
    return {
      verdict: 'missing' as const,
      gap: '资产负债/balanceSheet/所有者权益全部零命中，无页面无接口',
      evidence,
    }
  },
})

defineCheck({
  id: 'M08-09',
  module: '08',
  title: '财务报表 — 费用分析表',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const kw = grepMatrix(['费用分析', 'expenseReport', 'expenseAnalysis', '费用科目'], 'app lib components')
    evidence.push(`关键词命中: ${JSON.stringify(kw)}`)
    const r = await api('/api/analytics/expenses')
    evidence.push(`接口: ${r.brief}`)
    return {
      verdict: 'missing' as const,
      gap: '费用分析/expenseReport/费用科目全部零命中；且无「其他支出」录入模块，' +
        '费用数据本身就没有来源',
      evidence,
    }
  },
})
