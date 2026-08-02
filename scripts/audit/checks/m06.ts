/**
 * M06 仓储与库存管理中心
 *   ① 多温区仓库管理 ② 批次与效期管理(FIFO/临期预警/追溯)
 *   ③ 库存实时监控 + 多仓库调拨 ④ 库存盘点 ⑤ 损耗管理 ⑥ 收货管理
 */
import { defineCheck, api, grepCode, grepMatrix, hasModel, prisma } from '../harness'

defineCheck({
  id: 'M06-01',
  module: '06',
  title: '多温区仓库管理（冷库/冷藏/冷冻/常温）',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    const zones = await prisma.zone.findMany({ select: { key: true, nameZh: true, tempRangeLabel: true } })
    evidence.push(`温区 ${zones.length} 个: ${zones.map(z => `${z.key}(${z.nameZh}${z.tempRangeLabel ? ' ' + z.tempRangeLabel : ''})`).join(', ')}`)

    const withZone = await prisma.product.count({ where: { currentZoneId: { not: null } } })
    const total = await prisma.product.count()
    evidence.push(`已归温区的商品: ${withZone}/${total}`)

    const r = await api('/api/zones')
    evidence.push(r.brief)

    return zones.length >= 3
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: `只有 ${zones.length} 个温区`, evidence }
  },
})

defineCheck({
  id: 'M06-02',
  module: '06',
  title: '批次与效期管理（FIFO / 临期预警 / 全程追溯）',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    const lots = await prisma.lot.count()
    const available = await prisma.lot.count({ where: { status: 'AVAILABLE' } })
    evidence.push(`Lot 批次 ${lots} 个（可用 ${available}）`)

    // FIFO 排序依据必须是入库时间，且真的按这个顺序取
    const fifo = grepCode('orderBy: \\{ arrivedAt', { roots: 'lib/inventory.ts', max: 2 })
    evidence.push(...fifo.map(l => `FIFO 排序: ${l.slice(0, 120)}`))

    // 实查：某商品的可用批次是否按 arrivedAt 升序被消耗
    const grouped = await prisma.lot.groupBy({
      by: ['productId'],
      where: { status: 'AVAILABLE', currentQty: { gt: 0 } },
      _count: true,
      having: { productId: { _count: { gt: 1 } } },
      orderBy: { productId: 'asc' },
      take: 1,
    })
    if (grouped.length > 0) {
      const pid = grouped[0].productId
      const list = await prisma.lot.findMany({
        where: { productId: pid, status: 'AVAILABLE', currentQty: { gt: 0 } },
        orderBy: { arrivedAt: 'asc' },
        select: { lotNumber: true, arrivedAt: true, currentQty: true, initialQty: true, bestBefore: true },
        take: 4,
      })
      evidence.push(
        `多批次商品实查（应先耗最早入库的）: ` +
        list.map(l => `${l.lotNumber}@${l.arrivedAt.toISOString().slice(0, 10)} 余${l.currentQty}/${l.initialQty}`).join(' | '),
      )
      // 先进先出的可观测特征：较早批次的消耗比例 >= 较晚批次
      const ratios = list.map(l => Number(l.initialQty) > 0 ? 1 - Number(l.currentQty) / Number(l.initialQty) : 0)
      const monotonic = ratios.every((v, i) => i === 0 || v <= ratios[i - 1] + 0.0001)
      evidence.push(`消耗比例 ${ratios.map(r => (r * 100).toFixed(0) + '%').join(' ≥ ')} → ${monotonic ? '符合 FIFO' : '不符合 FIFO（较晚批次先被消耗）'}`)
    } else {
      evidence.push('没有同一商品存在多个可用批次的情况，无法观察 FIFO 顺序')
    }

    // 临期预警
    const exp = await api('/api/lots/expiring')
    evidence.push(`临期预警接口: ${exp.brief}`)

    // 追溯：StockMove 是否落到 lotId
    const movesWithLot = await prisma.stockMove.count({ where: { lotId: { not: null } } })
    const moves = await prisma.stockMove.count()
    evidence.push(`StockMove 带 lotId（批次级追溯）: ${movesWithLot}/${moves}`)

    const ok = lots > 0 && fifo.length > 0 && exp.status === 200
    return ok
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: '批次/FIFO/临期三者未同时成立', evidence }
  },
})

defineCheck({
  id: 'M06-03',
  module: '06',
  title: '库存实时监控 + 多仓库调拨',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    evidence.push(`schema 中有 Warehouse 模型: ${hasModel('Warehouse') ? '是' : '否'}`)
    const transferKw = grepMatrix(['调拨', 'warehouseTransfer', 'stockTransfer', 'TRANSFER'], 'app lib prisma/schema.prisma')
    evidence.push(`调拨关键词命中: ${JSON.stringify(transferKw)}`)

    // 实时监控这一半是真的
    const inv = await api('/api/products?pageSize=1')
    evidence.push(`库存查询接口: ${inv.brief}`)
    const safety = grepMatrix(['safetyStock', '安全库存', 'lowStock', '库存预警'], 'app lib prisma/schema.prisma')
    evidence.push(`安全库存/预警命中: ${JSON.stringify(safety)}`)

    const negative = await prisma.product.count({ where: { qtyOnHand: { lt: 0 } } })
    evidence.push(`负库存商品数: ${negative}`)

    return {
      verdict: 'partial' as const,
      gap: '单仓库内的实时监控、安全库存与预警完整；但数据模型里没有 Warehouse 实体——' +
        '现为「单仓库 + 多温区(Zone)」架构，跨仓调拨无从谈起',
      evidence,
    }
  },
})

defineCheck({
  id: 'M06-04',
  module: '06',
  title: '库存盘点（盘点单 / 循环盘点 / 差异调整）',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    const takes = await prisma.stockTake.count()
    const lines = await prisma.stockTakeLine.count()
    evidence.push(`StockTake ${takes} 单 / StockTakeLine ${lines} 行`)

    const r = await api('/api/stock-takes')
    evidence.push(r.brief)

    const diff = grepCode('diff|差异|adjust', { roots: 'app/api/stock-takes', max: 4 })
    evidence.push(...diff.map(l => `差异调整: ${l.slice(0, 120)}`))

    const cycle = grepMatrix(['循环盘点', 'cycleCount', 'cycle_count'], 'app lib prisma/schema.prisma')
    evidence.push(`循环盘点命中: ${JSON.stringify(cycle)}`)

    const ok = r.status === 200 && diff.length > 0
    return ok
      ? {
          verdict: 'done' as const,
          gap: takes === 0 ? '功能齐全但生产上尚无盘点单据' : undefined,
          evidence,
        }
      : { verdict: 'partial' as const, gap: '盘点差异调整链路不完整', evidence }
  },
})

defineCheck({
  id: 'M06-05',
  module: '06',
  title: '损耗管理（原因码 / 归因分析 / 损耗报表）',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    const scrap = await prisma.stockMove.count({ where: { type: 'SCRAP' } })
    evidence.push(`SCRAP 类型库存移动: ${scrap} 条`)

    const reasonCode = grepCode('SCRAP_REASON|损耗原因|scrapReason', { roots: 'app lib prisma/schema.prisma', max: 4 })
    evidence.push(...reasonCode.map(l => `原因码: ${l.slice(0, 120)}`))

    const dash = await api('/api/analytics/loss-dashboard?days=30')
    evidence.push(`损耗归因接口: ${dash.brief}`)

    const ok = dash.status === 200
    return ok
      ? { verdict: 'done' as const, gap: scrap === 0 ? '功能在但生产上尚无 SCRAP 记录' : undefined, evidence }
      : { verdict: 'partial' as const, gap: `损耗分析接口返回 ${dash.status}`, evidence }
  },
})

defineCheck({
  id: 'M06-06',
  module: '06',
  title: '收货管理（采购单自动生成收货凭据 / 拍照存证 / 验货记录）',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    const grs = await prisma.goodsReceipt.count()
    evidence.push(`GoodsReceipt 收货单: ${grs} 条`)

    const r = await api('/api/goods-receipts')
    evidence.push(r.brief)

    const feats = grepMatrix(['photos', 'condition', '良品', 'damaged', 'lot.create'], 'app/api/goods-receipts')
    const withPhoto = await prisma.goodsReceipt.count({ where: { NOT: { photos: { isEmpty: true } } } })
    evidence.push(`带取证照片的收货单: ${withPhoto}/${grs}（GoodsReceipt.photos 为 base64 data URI 数组）`)
    evidence.push(`收货特性命中: ${JSON.stringify(feats)}`)

    const lotFromReceipt = grepCode('保质期优先用本次收货行实际填写', { roots: 'app/api/goods-receipts', max: 2 })
    evidence.push(...lotFromReceipt.map(l => `收货建批次: ${l.slice(0, 130)}`))

    const ok = r.status === 200
    return ok
      ? { verdict: 'done' as const, gap: grs === 0 ? '功能在但生产上尚无收货单' : undefined, evidence }
      : { verdict: 'partial' as const, gap: `收货接口返回 ${r.status}`, evidence }
  },
})
