/**
 * M09 数据分析与 BI 决策中心
 *   ① 经营看板 ② 客户分析(RFM/复购率/流失预警) ③ 商品分析(ABC/畅销滞销/毛利排行/价格敏感度)
 *   ④ 销售预测(机器学习模型) ⑤ 灵活数据分析(Odoo 式多维度可组合)
 */
import { defineCheck, api, grepCode, grepMatrix, findFiles, prisma } from '../harness'

defineCheck({
  id: 'M09-01',
  module: '09',
  title: '经营看板（核心 KPI 大屏）',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    const r = await api('/api/analytics/overview')
    evidence.push(r.brief)

    const snaps = await prisma.dailyBusinessSnapshot.count()
    const latest = await prisma.dailyBusinessSnapshot.findFirst({
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true, salesExTax: true, orderCount: true, activeCustomers: true },
    })
    evidence.push(
      `DailyBusinessSnapshot 快照 ${snaps} 天，最新 ${latest?.snapshotDate?.toISOString().slice(0, 10) ?? '无'}` +
      `（销售额 ${latest?.salesExTax ?? '-'} / ${latest?.orderCount ?? '-'} 单 / 活跃客户 ${latest?.activeCustomers ?? '-'}）`,
    )

    const kpi = grepCode('库存周转|损耗率|客户新增|销售趋势', { roots: 'app components lib', max: 5 })
    evidence.push(...kpi.map(l => `KPI: ${l.slice(0, 110)}`))

    return r.status === 200 && snaps > 0
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: '看板接口或快照表不可用', evidence }
  },
})

defineCheck({
  id: 'M09-02',
  module: '09',
  title: '客户分析（RFM 模型 / 复购率 / 流失预警 / 购买偏好）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []
    const r = await api('/api/analytics/customers?days=90')
    evidence.push(r.brief)
    const keys = r.body && typeof r.body === 'object' ? Object.keys(r.body as object) : []
    evidence.push(`返回视图: ${keys.join(', ')}`)

    const kw = grepMatrix(['rfm', 'recency.*frequency', '复购率', 'repurchaseRate'], 'app lib components')
    evidence.push(`RFM/复购率关键词命中: ${JSON.stringify(kw)}`)

    const churn = grepCode('churn|流失预警', { roots: 'app lib components', max: 3 })
    evidence.push(...churn.map(l => `流失预警: ${l.slice(0, 120)}`))

    const hasRfm = kw['rfm'] > 0
    const hasRepurchase = kw['复购率'] > 0 || kw['repurchaseRate'] > 0

    return {
      verdict: 'partial' as const,
      gap: `客户分层（ABC）与流失预警已实现并有接口；` +
        `但 ${hasRfm ? '' : 'RFM 模型零命中（现有分层只按销售额排序做 ABC，不是 R/F/M 三维打分）'}` +
        `${!hasRfm && !hasRepurchase ? '，' : ''}` +
        `${hasRepurchase ? '' : '复购率指标零命中'}`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M09-03',
  module: '09',
  title: '商品分析（ABC 分类 / 畅销滞销 / 毛利排行 / 价格敏感度）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const sub: Record<string, string> = {}

    const margin = await api('/api/analytics/margin?days=30')
    sub['毛利排行'] = margin.status === 200 ? '✓' : '✗'
    evidence.push(`毛利排行: ${margin.brief}`)

    // ABC 是客户维度还是商品维度
    const abcWhere = grepCode('abc', { roots: 'app/api/analytics lib/analytics', max: 5 })
    evidence.push(...abcWhere.map(l => `ABC 命中: ${l.slice(0, 120)}`))
    const abcOnProduct = abcWhere.some(l => /product/i.test(l))
    sub['商品 ABC'] = abcOnProduct ? '✓' : '✗（现有 ABC 是客户维度，不是商品维度）'

    // 畅销/滞销
    const rank = grepMatrix(['滞销', 'slowMoving', '畅销', 'bestSeller', 'topProducts'], 'app lib')
    sub['畅销滞销'] = rank['滞销'] > 0 || rank['slowMoving'] > 0 ? '✓' : '✗（只有 topProducts 畅销侧，无滞销识别）'
    evidence.push(`畅销/滞销命中: ${JSON.stringify(rank)}`)

    // 价格敏感度
    const elasticity = grepMatrix(['价格敏感', 'elasticity', 'priceSensitiv'], 'app lib components')
    sub['价格敏感度'] = Object.values(elasticity).some(v => v > 0) ? '✓' : '✗'
    evidence.push(`价格敏感度命中: ${JSON.stringify(elasticity)}`)

    // 价格趋势接口（相邻能力）
    const trend = await api('/api/analytics/price-trends')
    evidence.push(`价格趋势接口: ${trend.brief}`)

    evidence.push(`四项子能力: ${Object.entries(sub).map(([k, v]) => `${k}=${v}`).join('；')}`)

    const okCount = Object.values(sub).filter(v => v === '✓').length
    return okCount === 4
      ? { verdict: 'done' as const, evidence }
      : {
          verdict: 'partial' as const,
          gap: `4 项子能力只完成 ${okCount} 项：${Object.entries(sub).filter(([, v]) => v !== '✓').map(([k, v]) => `${k}${v.replace('✗', '')}`).join('；')}`,
          evidence,
        }
  },
})

defineCheck({
  id: 'M09-04',
  module: '09',
  title: '销售预测（机器学习模型）',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const kw = grepMatrix(
      ['machine.?learn', 'regression', 'arima', '时间序列', 'prophet', 'tensorflow', 'onnx', 'neural', '训练集', 'backtest'],
      'app lib components',
    )
    evidence.push(`ML/预测关键词全集命中: ${JSON.stringify(kw)}`)

    const actual = grepCode('近3日日均出货|建议年度采购量', { roots: 'lib', max: 3 })
    evidence.push(...actual.map(l => `现有"预测"的真实形态: ${l.slice(0, 130)}`))

    const any = Object.values(kw).some(v => v > 0)
    return {
      verdict: any ? ('partial' as const) : ('missing' as const),
      gap: 'ML/回归/时间序列/prophet/backtest 等 10 个关键词全库零命中。' +
        '现有"预测"是两条确定性规则公式（生鲜：近3日日均出货+已确认未来订单−库存−在途；' +
        '干货：近12月量×同比增长率），没有模型、没有训练、没有回测，也不考虑天气与节假日',
      evidence,
    }
  },
})

defineCheck({
  id: 'M09-05',
  module: '09',
  title: '灵活数据分析（Odoo 式多维度、多条件、可组合）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    // 透视引擎
    const dims = grepCode('DIMENSION_DEFS', { roots: 'lib/analytics/pivot.ts', max: 2 })
    evidence.push(...dims.map(l => `透视引擎: ${l.slice(0, 120)}`))

    const engineExists = findFiles('lib/analytics', 'pivot.ts')
    evidence.push(`引擎文件: ${engineExists.join(', ') || '无'}`)

    // 两维交叉实测：rowBy × colBy
    const single = await api('/api/analytics/margin?days=30&groupBy=customer')
    evidence.push(`单维分组: ${single.brief}`)

    const cross = await api('/api/analytics/margin?days=30&groupBy=customer&colBy=month')
    evidence.push(`两维交叉（客户 × 月份）: ${cross.brief}`)

    const crossBody = cross.body as Record<string, unknown>
    const isPivot = !!crossBody && ('columns' in crossBody || 'cols' in crossBody || 'matrix' in crossBody)
    evidence.push(`交叉返回体含列维: ${isPivot ? '是' : '否'}（keys: ${Object.keys(crossBody ?? {}).join(',')}）`)

    // 可选维度数量
    const dimList = grepCode("^\\s+\\w+: \\{", { roots: 'lib/analytics/pivot.ts', max: 12 })
    evidence.push(`pivot 白名单维度定义行数: ${dimList.length}`)

    // UI 是否接线
    const ui = grepCode('PivotView|colBy', { roots: 'app/\\[locale\\]/classic/boss/analytics', max: 4 })
    evidence.push(...ui.map(l => `UI 接线: ${l.slice(0, 120)}`))

    const ok = engineExists.length > 0 && cross.status === 200 && isPivot && ui.length > 0
    if (ok) {
      return {
        verdict: 'partial' as const,
        gap: '0729 说"一次只能选一个维度、做不到客户×月份交叉"——**已被 20260801 的透视模式推翻**：' +
          '`lib/analytics/pivot.ts` 提供白名单维度 + `buildPivot`，毛利分析支持 `groupBy × colBy` 两维交叉，' +
          'UI 有 PivotView 切换。仍未达 Odoo 12 水准的是：只有毛利分析一张表接了透视' +
          '（sale/purchase report 其余页面仍是预设报表），筛选条件仍以日期范围为主',
        evidence,
      }
    }
    return { verdict: 'partial' as const, gap: '透视引擎存在但未跑通两维交叉', evidence }
  },
})
