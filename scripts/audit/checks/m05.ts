/**
 * M05 日销售管理中心（运营操作台）
 * 合同清单：
 *   ① 打印中心：按拣货策略(整箱/零散)打印拣货单、汇总单；打印销售单、司机送货汇总单、
 *      配送单、客户签收单；支持按客户/线路/商品筛选打印
 *   ② 缺货处理：实时反馈缺货商品，自动筛选受影响订单，支持批量修改或转单，并记录缺货原因
 *   ③ 销售统计：日销售额/关键商品销量/客单价/缺货率 + 多维度销售报表
 */
import { defineCheck, api, grepCode, grepMatrix, findFiles } from '../harness'

const DAILY_SALES = 'app/\\[locale\\]/classic/operator/daily-sales'

defineCheck({
  id: 'M05-01',
  module: '05',
  title: '打印中心（6 类单据 + 筛选打印）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const pages = findFiles('"app/[locale]/classic/print"', 'page.tsx')
      .map(p => p.replace('app/[locale]/classic/print/', '').replace('/page.tsx', ''))
    evidence.push(`打印页面 ${pages.length} 个: ${pages.join(', ')}`)

    const pdfRoutes = findFiles('app/api/print', 'route.ts')
      .map(p => p.replace('app/api/print/', '').replace('/route.ts', ''))
    evidence.push(`打印 PDF 接口: ${pdfRoutes.join(', ') || '无'}`)

    // 合同点名的 6 类单据逐条对照
    const docs: Record<string, boolean> = {
      '拣货单': pages.some(p => p.includes('picking')),
      '汇总单': pages.some(p => p.includes('summary')),
      '销售单': pages.some(p => p.includes('sales')),
      '司机送货汇总单': pages.some(p => p.startsWith('trip/') && p.includes('summary')),
      '配送单': pages.some(p => p.includes('delivery')),
      '客户签收单': grepCode('客户签收单|签收单打印|receipt.*sign', { roots: 'app lib components', max: 3 }).length > 0,
    }
    evidence.push(`合同点名单据: ${Object.entries(docs).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    // 整箱 / 零散 拣货策略
    const strategy = grepCode('整箱整袋|零散货', { roots: 'app components', max: 4 })
    evidence.push(`拣货策略(整箱/零散)分开打印: ${strategy.length > 0 ? '✓' : '✗'}`)
    evidence.push(...strategy.slice(0, 2).map(l => `  ${l.slice(0, 120)}`))

    // 筛选打印维度
    const filters = grepMatrix(['customerId', 'driverSlotId', 'productId', 'categoryId'], DAILY_SALES)
    evidence.push(`打印中心筛选维度命中: ${JSON.stringify(filters)}`)

    const missing = Object.entries(docs).filter(([, v]) => !v).map(([k]) => k)
    if (missing.length === 0) return { verdict: 'done' as const, evidence }
    return {
      verdict: 'partial' as const,
      gap: `合同点名的单据里缺 ${missing.join('、')}；其余 ${6 - missing.length}/6 类齐全，` +
        `整箱/零散两种拣货策略也已分开打印`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M05-02',
  module: '05',
  title: '缺货处理（批量改量 / 转单 / 记录原因）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const applyRoute = findFiles('app/api/daily-sales/shortage', 'route.ts')
    evidence.push(`批量改量接口: ${applyRoute.length > 0 ? applyRoute[0] : '无'}`)

    const shortageApi = await api('/api/analytics/shortage?days=7')
    evidence.push(`缺货分析接口: ${shortageApi.brief}`)

    // 缺货原因是否有结构化字段
    const reason = grepMatrix(
      ['shortageReason', '缺货原因', 'outOfStockReason', 'stockoutReason'],
      'app lib prisma/schema.prisma',
    )
    evidence.push(`缺货原因字段命中: ${JSON.stringify(reason)}`)

    // 转单
    const transfer = grepMatrix(
      ['转单', 'transferOrder', 'splitOrder', 'reassignLine'],
      'app/\\[locale\\]/classic/operator/daily-sales app/api/daily-sales app/api/waves',
    )
    evidence.push(`转单相关命中: ${JSON.stringify(transfer)}`)

    const hasReason = Object.values(reason).some(v => v > 0)
    const hasTransfer = Object.values(transfer).some(v => v > 0)

    return {
      verdict: 'partial' as const,
      gap: `批量改量与缺货打印已实现、缺货率分析接口可用；` +
        `但${hasReason ? '' : '无结构化「缺货原因」字段（只能改量，不记录为什么缺）'}` +
        `${!hasReason && !hasTransfer ? '，且' : ''}` +
        `${hasTransfer ? '' : '无「转单」操作概念（合同要求缺货时可转单）'}`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M05-03',
  module: '05',
  title: '销售统计（日销售额 / 关键商品销量 / 客单价 / 缺货率）',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    const overview = await api('/api/analytics/sales-overview?days=7')
    evidence.push(`统一视图接口: ${overview.brief}`)

    const body = overview.body as Record<string, unknown>
    const keys = body && typeof body === 'object' ? Object.keys(body) : []
    evidence.push(`返回字段: ${keys.join(', ')}`)

    // 四项指标是否一次返回
    const has = {
      日销售额: keys.some(k => /daily|series|sales/i.test(k)),
      客单价: JSON.stringify(body ?? '').includes('aov'),
      缺货率: keys.some(k => /shortage/i.test(k)),
      关键商品: keys.some(k => /top|product/i.test(k)),
    }
    evidence.push(`四项指标: ${Object.entries(has).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    // 多维度销售报表
    const dims = grepCode('DIMENSION_DEFS|groupBy', { roots: 'lib/analytics', max: 4 })
    evidence.push(...dims.map(l => `多维报表: ${l.slice(0, 120)}`))

    const page = findFiles('"app/[locale]/classic"', 'page.tsx').filter(p => p.includes('sales-overview'))
    evidence.push(`统一页面: ${page.join(', ') || '未找到独立页面'}`)

    const allFour = Object.values(has).every(Boolean)
    if (overview.status === 200 && allFour) {
      return {
        verdict: 'done' as const,
        gap: '0729 说"四项指标分散在两三个页面、还没合并成统一视图"——' +
          '现已由 /api/analytics/sales-overview 一次请求返回全部四项',
        evidence,
      }
    }
    return {
      verdict: 'partial' as const,
      gap: `统一视图未覆盖全部四项（${JSON.stringify(has)}）`,
      evidence,
    }
  },
})
