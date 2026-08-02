/**
 * M03 配送与司机电子签收（TMS & POD 配送端）
 * 合同清单：
 *   ① 司机管理：批次/时段/司机独立配置，后台可独立搜索
 *   ② 快速派单：销售单列表页快速派单
 *   ③ 拖拽调度：按送货窗口与路线半自动派单
 *   ④ 司机端 App：按序导航 + 客户电子签名（Sign on Glass）
 *   ⑤ 车辆调度：Google 地图显示司机路线图
 *   ⑥ 现场退改：少货/坏货现场调整并生成电子退款凭证
 *   ⑦ 对账回传：签收后收款/欠款数据即时回传
 */
import { defineCheck, api, grepCode, grepMatrix, prisma } from '../harness'

const DRIVER_PAGE = 'app/\\[locale\\]/classic/driver'
const DISPATCH = 'app/\\[locale\\]/classic/operator/dispatch-console'

defineCheck({
  id: 'M03-01',
  module: '03',
  title: '司机管理（批次 / 时段 / 独立配置 + 后台搜索）',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    const r = await api('/api/driver-slots')
    evidence.push(r.brief)

    const slots = await prisma.driverSlot.findMany({
      select: { timeOfDay: true, batchNum: true, driverName: true, userId: true, archived: true },
    })
    const active = slots.filter(s => !s.archived)
    const bound = active.filter(s => s.userId)
    const timeOfDays = new Set(active.map(s => s.timeOfDay))
    const batches = new Set(active.map(s => s.batchNum))
    evidence.push(
      `DriverSlot 共 ${slots.length}（在用 ${active.length}）：时段 ${[...timeOfDays].join('/')}，` +
      `批次 ${[...batches].sort().join(',')}，已绑定 DRIVER 账号 ${bound.length}/${active.length}`,
    )

    const ui = grepCode('排序|筛选|search', { roots: 'app/\\[locale\\]/classic/operator/drivers', max: 3 })
    evidence.push(`司机配置页搜索/排序命中 ${ui.length} 处`)

    const ok = r.status === 200 && timeOfDays.size >= 2 && batches.size >= 2
    return ok
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: '时段/批次维度不完整', evidence }
  },
})

defineCheck({
  id: 'M03-02',
  module: '03',
  title: '销售单列表页快速派单',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    const inline = grepCode('/batch.*driverSlotId|driverSlotId.*slotId', {
      roots: 'app/\\[locale\\]/classic/operator/orders/page.tsx', max: 3,
    })
    evidence.push(...inline.map(l => `列表页内嵌派单: ${l.slice(0, 130)}`))

    const routeExists = grepCode('export async function PUT', { roots: 'app/api/orders/\\[id\\]/batch', max: 2 })
    evidence.push(`派单接口 PUT /api/orders/[id]/batch: ${routeExists.length > 0 ? '存在' : '不存在'}`)

    const assigned = await prisma.order.count({ where: { driverSlotId: { not: null } } })
    const total = await prisma.order.count()
    evidence.push(`生产数据佐证：${assigned}/${total} 单已带 driverSlotId`)

    const ok = inline.length > 0 && routeExists.length > 0
    return ok
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: '列表页未接入派单或派单接口缺失', evidence }
  },
})

defineCheck({
  id: 'M03-03',
  module: '03',
  title: '拖拽调度：按送货窗口与路线半自动派单',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const drag = grepCode('onDragStart|onDrop|draggable', { roots: DISPATCH, max: 4 })
    evidence.push(`调度台拖拽实现命中 ${drag.length} 处`)
    evidence.push(...drag.slice(0, 2).map(l => `  ${l.slice(0, 120)}`))

    // 送货窗口：时段维度是否进入调度
    const window = grepCode('timeOfDay', { roots: DISPATCH, max: 3 })
    evidence.push(`送货窗口(timeOfDay)进入调度台: ${window.length > 0 ? '是' : '否'}`)

    // 路线：是否有地理辅助（可视化/距离预警），以及是否有自动分批
    const geo = await api('/api/batch-analysis')
    evidence.push(`地理分批分析接口: ${geo.brief}`)
    const hullViz = grepCode('convexHull|总距离超过平均值', { roots: 'components/shared', max: 3 })
    evidence.push(...hullViz.map(l => `地理辅助: ${l.slice(0, 120)}`))

    // 真正的"半自动"要有自动生成分派方案
    const autoAssign = grepMatrix(
      ['autoAssign', 'auto-assign', '自动派单', 'optimizeRoute', 'vrp', 'clustering', 'kmeans'],
      'app lib components',
    )
    evidence.push(`自动派单/路线优化关键词命中: ${JSON.stringify(autoAssign)}`)
    const anyAuto = Object.values(autoAssign).some(v => v > 0)

    return {
      verdict: 'partial' as const,
      gap: anyAuto
        ? '存在自动派单代码但未接入调度台'
        : '拖拽为纯手动；系统提供地理分布可视化(凸包分组)与"总距离超均值2倍"预警作决策辅助，' +
          '但不生成分派方案、不做路线优化，达不到合同所说的"半自动派单"',
      evidence,
    }
  },
})

defineCheck({
  id: 'M03-04',
  module: '03',
  title: '司机端 App：按序导航 + 客户电子签名（Sign on Glass）',
  prev: 'missing',
  async run() {
    const evidence: string[] = []

    // 电子签名：触屏手写捕获
    const sig = grepMatrix(
      ['signature', 'signaturePad', 'signOnGlass', '签名', 'toDataURL', 'getContext..2d'],
      'app lib components',
    )
    evidence.push(`电子签名关键词命中: ${JSON.stringify(sig)}`)

    // 实际的签收凭证是什么形式
    const proof = grepCode('photo|拍照', { roots: DRIVER_PAGE, max: 4 })
    evidence.push(...proof.map(l => `现有签收凭证形式: ${l.slice(0, 120)}`))

    // 按序导航：是否有停靠点顺序 + 逐点导航
    const nav = grepCode('导航|navUrl|maps.google|geo:', { roots: DRIVER_PAGE, max: 4 })
    evidence.push(...nav.map(l => `导航: ${l.slice(0, 120)}`))
    const seq = grepMatrix(['stopSequence', 'stopIndex', 'sortOrder', 'routeOrder', '按序'], DRIVER_PAGE)
    evidence.push(`停靠点排序字段命中: ${JSON.stringify(seq)}`)

    const hasSig = sig['signature'] > 0 || sig['签名'] > 0 || sig['signaturePad'] > 0
    const hasNav = nav.length > 0
    const hasSeq = Object.values(seq).some(v => v > 0)

    if (!hasSig && !hasSeq && hasNav) {
      return {
        verdict: 'partial' as const,
        gap: '有逐点「🧭 导航」按钮（跳外部地图），但停靠点无排序字段、不构成"按序"导航；' +
          '电子签名完全没有——现有签收凭证是拍照上传，不是手写签名捕获',
        evidence,
      }
    }
    if (hasSig) return { verdict: 'partial' as const, gap: '签名代码存在，需确认是否接入司机端', evidence }
    return { verdict: 'missing' as const, gap: '无电子签名、无按序导航', evidence }
  },
})

defineCheck({
  id: 'M03-05',
  module: '03',
  title: '车辆调度：Google 地图显示司机路线图',
  prev: 'missing',
  async run() {
    const evidence: string[] = []

    // 地图组件是否已接进司机端
    const inDriver = grepCode('BatchMap|routeMarkers', { roots: DRIVER_PAGE, max: 4 })
    evidence.push(...inDriver.map(l => `司机端地图: ${l.slice(0, 130)}`))

    const mapApis = grepMatrix(
      ['DirectionsService', 'DirectionsRenderer', 'Polyline', 'AdvancedMarkerElement', 'distancematrix', 'geocode'],
      'app lib components',
    )
    evidence.push(`地图 API 使用情况: ${JSON.stringify(mapApis)}`)

    const hasMapInDriver = inDriver.length > 0
    const hasDirections = mapApis['DirectionsService'] > 0 || mapApis['DirectionsRenderer'] > 0
    const hasPolyline = mapApis['Polyline'] > 0

    if (hasMapInDriver && hasDirections) return { verdict: 'done' as const, evidence }
    if (hasMapInDriver) {
      return {
        verdict: 'partial' as const,
        gap: '司机端行程页已内嵌地图并打出各停靠点标记（提交 0cb4c52，0729 之后落地）；' +
          '但只画点不画线——未接 Directions API、无路径规划折线，仍不是"路线图"',
        evidence,
      }
    }
    return { verdict: 'missing' as const, gap: '司机端无地图', evidence }
  },
})

defineCheck({
  id: 'M03-06',
  module: '03',
  title: '现场退改：生成电子退款凭证',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const fieldReport = grepCode('openExceptionModal|returns.push|handleReturnPhoto', { roots: DRIVER_PAGE, max: 4 })
    evidence.push(...fieldReport.map(l => `现场上报: ${l.slice(0, 120)}`))

    const discCount = await prisma.orderDiscrepancy.count()
    const cnCount = await prisma.creditNote.count()
    evidence.push(`生产数据：OrderDiscrepancy ${discCount} 条，CreditNote ${cnCount} 条`)

    // 是否自动：司机上报后凭证是自动生成还是要人工审批
    const approval = grepCode('approv|审批|status.*PENDING', { roots: 'app/api/order-discrepancies', max: 5 })
    evidence.push(...approval.map(l => `审批环节: ${l.slice(0, 120)}`))

    const autoGen = grepCode('creditNote.create', { roots: 'app/api/order-discrepancies', max: 3 })
    evidence.push(`异常上报处直接生成退款单: ${autoGen.length > 0 ? '是' : '否（需另行在 credit-notes 开单）'}`)

    return {
      verdict: 'partial' as const,
      gap: '司机现场可即时上报少货/坏货并拍照存证（OrderDiscrepancy），退款单模型(CreditNote)也在；' +
        '但两者不自动衔接——凭证需人工审批后由财务另行开具，不是合同所说的"现场生成电子退款凭证"',
      evidence,
    }
  },
})

defineCheck({
  id: 'M03-07',
  module: '03',
  title: '对账回传：签收后收款/欠款数据即时回传',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    // 行程完成后的自动回写
    const onComplete = grepCode('COMPLETED', { roots: 'app/api/trips/\\[id\\]/route.ts', max: 6 })
    evidence.push(`行程完成回写逻辑命中 ${onComplete.length} 处`)

    const invAuto = grepCode('invoice.create|invoice.upsert|freezeTripCommission', {
      roots: 'app/api/trips lib/commission.ts', max: 5,
    })
    evidence.push(...invAuto.map(l => `完成即回写: ${l.slice(0, 120)}`))

    // 司机交账：现金是否自动落成收款
    const settle = await prisma.trip.groupBy({
      by: ['settlementStatus'],
      _count: true,
    }).catch(() => [] as { settlementStatus: string | null; _count: number }[])
    evidence.push(`交账状态分布: ${settle.map(s => `${s.settlementStatus}=${s._count}`).join(' ') || '无'}`)

    const paymentOnSettle = grepCode('payment.create', { roots: 'app/api/trips', max: 3 })
    evidence.push(`财务确认交账时创建 Payment: ${paymentOnSettle.length > 0 ? '是' : '否'}`)

    const invCount = await prisma.invoice.count()
    const payCount = await prisma.payment.count()
    evidence.push(`生产数据：Invoice ${invCount} 张，Payment ${payCount} 条`)

    return {
      verdict: 'partial' as const,
      gap: '行程完成会自动回写发票草稿、订单状态、司机提成冻结；司机交账也有结构化流程' +
        '（司机提交 cashCollected → 财务确认/退回）。但财务确认只翻转 Trip.settlementStatus，' +
        '不生成 Payment 收款记录，现金入账仍需在收款模块另行录入',
      evidence,
    }
  },
})
