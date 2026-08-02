/**
 * M02 Quotation 和销售单
 * 合同清单：
 *   ① 创建/修改 quotation：重复商品及缺货商品提醒
 *   ② 定价与 commission 自动计算：多层级、多样价格逻辑、价格嵌套
 *   ③ 快捷按键：tab / enter
 *   ④ quotation↔销售单状态切换、批量操作、退回 quotation、查询、取消
 */
import { defineCheck, api, grepCode, grepCount, prisma, PROBE_MARK } from '../harness'

const PLACE_ORDER = 'app/\\[locale\\]/classic/operator/place-order'
const QUOTATION = 'app/\\[locale\\]/classic/operator/quotations'

defineCheck({
  id: 'M02-01',
  module: '02',
  title: '创建/修改 quotation：重复商品及缺货商品提醒',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const dup = grepCode('重复商品提醒|Duplicate Product Alert', { roots: PLACE_ORDER, max: 3 })
    evidence.push(...dup.map(l => `重复提醒: ${l.slice(0, 130)}`))

    // 缺货提醒：下单页 + 报价单编辑页两处都要有
    const soPlace = grepCode('out of stock|无可用库存|库存不足', { roots: PLACE_ORDER, max: 3 })
    const soQuote = grepCode('缺货提醒|forecastMap|pending-demand', { roots: QUOTATION, max: 4 })
    evidence.push(...soPlace.map(l => `下单页缺货: ${l.slice(0, 130)}`))
    evidence.push(...soQuote.map(l => `报价页缺货: ${l.slice(0, 130)}`))

    // 缺货判定的数据来源接口是否真的活着
    const atp = await api('/api/products/pending-demand')
    evidence.push(`ATP/缺货数据源: ${atp.brief}`)

    const hasDup = dup.length > 0
    const hasShortage = soPlace.length > 0 && soQuote.length > 0

    if (hasDup && hasShortage) {
      return {
        verdict: 'done' as const,
        gap: '提醒为「警告不阻断」——缺货仍可下单，符合生鲜业务常规，但非硬校验',
        evidence,
      }
    }
    return {
      verdict: 'partial' as const,
      gap: hasDup ? '缺货提醒未覆盖两个录单入口' : '未找到重复商品提醒',
      evidence,
    }
  },
})

defineCheck({
  id: 'M02-02',
  module: '02',
  title: '定价与 commission 自动计算（多层级、价格嵌套）',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    // 定价：价格表链式解析真实生效？
    const plCount = await prisma.odooPricelist.count()
    const boundCount = await prisma.customerPricelist.count()
    evidence.push(`价格表 ${plCount} 张，客户绑定 ${boundCount} 条`)

    // 嵌套：价格表 item 是否支持指向另一张价格表
    const nested = grepCode('basePricelistId|base_pricelist|嵌套', { roots: 'lib/pricing-engine.ts prisma/schema.prisma', max: 5 })
    evidence.push(...nested.map(l => `嵌套: ${l.slice(0, 130)}`))

    // 实测：客户端商品接口返回的 priceSource 说明命中了哪条规则
    const r = await api('/api/customer-portal/products', { role: 'RESTAURANT' })
    const prods = ((r.body as { products?: Record<string, unknown>[] })?.products ?? [])
    const sources = new Set(prods.map(p => String(p.priceSource ?? '')).filter(Boolean))
    evidence.push(`实测取价命中的规则种类 ${sources.size} 种，样例: ${[...sources].slice(0, 3).join(' | ')}`)

    // commission：两种模式是否都建模并落到订单行
    const rateField = grepCount('commissionRate', 'prisma/schema.prisma')
    const fixedField = grepCount('commissionFixed', 'prisma/schema.prisma')
    const prodComm = grepCount('commissionPrice', 'prisma/schema.prisma')
    evidence.push(`schema: commissionRate=${rateField} commissionFixed=${fixedField} commissionPrice=${prodComm}`)

    const withComm = await prisma.orderLine.count({ where: { commissionPrice: { not: null } } })
    evidence.push(`订单行中已落 commissionPrice 的行数: ${withComm}`)

    const engineOk = plCount > 0 && boundCount > 0 && sources.size > 0
    const commOk = rateField > 0 && fixedField > 0 && prodComm > 0
    if (engineOk && commOk) return { verdict: 'done' as const, evidence }
    return {
      verdict: 'partial' as const,
      gap: !engineOk ? '价格表链路未取到实际数据' : 'commission 两种模式未同时建模',
      evidence,
    }
  },
})

defineCheck({
  id: 'M02-03',
  module: '02',
  title: '快捷按键：tab / enter 键操作',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const tab = grepCode("key === 'Tab'", { roots: 'components app', max: 8 })
    const enter = grepCode("key === 'Enter'", { roots: 'components app', max: 10 })
    evidence.push(`Tab 处理命中 ${tab.length} 处、Enter 处理命中 ${enter.length} 处`)
    evidence.push(...tab.map(l => `Tab: ${l.slice(0, 130)}`))

    // 自定义 Tab 导航（跳到下一行数量框）是否还在，还是回退成浏览器默认
    const tabNav = grepCode('onTabSelect|selectOnTab|handleTabNav', { roots: 'components app', max: 6 })
    evidence.push(...tabNav.map(l => `Tab 跳行: ${l.slice(0, 130)}`))

    const hasCustomTabNav = tabNav.some(l => l.includes('onTabSelect'))
    const wiredInEditor = grepCount('onTabSelect', 'components/classic app/\\[locale\\]/classic') > 1
    evidence.push(`自定义 Tab 跳行接线处数: ${grepCount('onTabSelect', 'components app')}`)

    if (hasCustomTabNav && wiredInEditor && enter.length > 0) {
      return {
        verdict: 'done' as const,
        gap: 'Tab 选中商品并跳到数量框、Enter 选中/提交均已实现；未做全表格方向键导航',
        evidence,
      }
    }
    return {
      verdict: 'partial' as const,
      gap: hasCustomTabNav ? 'Tab 逻辑存在但未接进录单编辑器' : 'Tab 已回退为浏览器默认行为',
      evidence,
    }
  },
})

defineCheck({
  id: 'M02-04',
  module: '02',
  title: 'quotation / 销售单状态切换、批量操作、退回 quotation',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    let probeOrderId: string | null = null
    let productId: string | null = null
    let stockBefore: number | null = null

    try {
      // ── 批量操作：代码存在性 ──────────────────────────────────────────
      const bulk = grepCode('handleBulkConfirm|handleBulkDelete|bulkPrinting', { roots: QUOTATION, max: 4 })
      evidence.push(...bulk.map(l => `批量: ${l.slice(0, 120)}`))

      // ── 状态机：允许的迁移是否显式定义 ────────────────────────────────
      const fsm = grepCode('CONFIRMED: new Set|PENDING: new Set', { roots: 'app/api/orders', max: 3 })
      evidence.push(...fsm.map(l => `状态机: ${l.slice(0, 120)}`))

      // ── 真实往返：建报价 → 确认（扣库存）→ 撤回（还库存）───────────────
      const prodRes = await api('/api/customer-portal/products', { role: 'RESTAURANT' })
      const prods = ((prodRes.body as { products?: Record<string, unknown>[] })?.products ?? [])
      const ids = prods.map(p => String(p.id))
      // 必须挑一个真有库存的商品，否则"确认扣库存"这一步等于没测
      const stocked = await prisma.product.findFirst({
        where: { id: { in: ids }, qtyOnHand: { gt: 5 } },
        select: { id: true, name: true, qtyOnHand: true },
      })
      if (!stocked) return { verdict: 'partial' as const, gap: '客户目录里没有带库存的商品，无法验证扣减/归还', evidence }
      productId = stocked.id
      stockBefore = Number(stocked.qtyOnHand)
      evidence.push(`选用商品「${stocked.name}」初始库存 ${stockBefore}`)

      const created = await api('/api/customer-portal/orders', {
        role: 'RESTAURANT', method: 'POST',
        body: { items: [{ productId, quantity: 1 }], paymentMethod: 'CASH', internalNote: PROBE_MARK },
      })
      probeOrderId = (created.body as { id?: string })?.id ?? null
      evidence.push(`① 建报价单: ${created.brief}`)
      if (!probeOrderId) return { verdict: 'partial' as const, gap: '建单失败，无法验证状态往返', evidence }

      const confirmed = await api(`/api/orders/${probeOrderId}`, {
        role: 'OPERATOR', method: 'PUT', body: { status: 'CONFIRMED' },
      })
      const afterConfirm = await prisma.product.findUnique({
        where: { id: productId }, select: { qtyOnHand: true },
      })
      evidence.push(`② 确认为销售单: ${confirmed.brief}`)
      evidence.push(`   库存 ${stockBefore} → ${Number(afterConfirm?.qtyOnHand ?? 0)}（确认应扣减）`)

      const reverted = await api(`/api/orders/${probeOrderId}`, {
        role: 'OPERATOR', method: 'PUT', body: { status: 'PENDING', confirmationDate: null },
      })
      const afterRevert = await prisma.product.findUnique({
        where: { id: productId }, select: { qtyOnHand: true },
      })
      const back = Number(afterRevert?.qtyOnHand ?? 0)
      evidence.push(`③ 撤回到报价单: ${reverted.brief}`)
      evidence.push(`   库存回到 ${back}（期望 ${stockBefore}，净变化 ${(back - stockBefore).toFixed(3)}）`)

      const row = await prisma.order.findUnique({
        where: { id: probeOrderId }, select: { status: true, confirmationDate: true },
      })
      evidence.push(`④ 最终状态 ${row?.status}，confirmationDate=${row?.confirmationDate ?? 'null'}`)

      // 审计留痕
      const audit = await prisma.orderAuditLog.findMany({
        where: { orderId: probeOrderId }, select: { action: true }, take: 5,
      }).catch(() => [])
      evidence.push(`⑤ 审计留痕: ${audit.map(a => a.action).join(' → ') || '无'}`)

      const roundTripOk =
        confirmed.status === 200 && reverted.status === 200 &&
        row?.status === 'PENDING' && Math.abs(back - stockBefore) < 0.001

      if (roundTripOk && bulk.length > 0) return { verdict: 'done' as const, evidence }
      return {
        verdict: 'partial' as const,
        gap: !roundTripOk
          ? `状态往返未闭合（确认=${confirmed.status} 撤回=${reverted.status} 终态=${row?.status} 库存净变化=${(back - stockBefore).toFixed(3)}）`
          : '未找到批量操作',
        evidence,
      }
    } finally {
      if (probeOrderId) {
        await prisma.orderAuditLog.deleteMany({ where: { orderId: probeOrderId } }).catch(() => {})
        await prisma.stockMove.deleteMany({ where: { refId: probeOrderId } }).catch(() => {})
        await prisma.orderLine.deleteMany({ where: { orderId: probeOrderId } })
        const del = await prisma.order.deleteMany({ where: { id: probeOrderId, internalNote: PROBE_MARK } })
        await prisma.actionLog.deleteMany({ where: { resource: 'Order', resourceId: probeOrderId } })
        evidence.push(`清理: 删除探针订单 ${probeOrderId} (${del.count} 行) + 其 StockMove/审计`)
        if (productId && stockBefore !== null) {
          const now = await prisma.product.findUnique({ where: { id: productId }, select: { qtyOnHand: true } })
          evidence.push(`清理后库存核对: ${Number(now?.qtyOnHand ?? 0)}（原始 ${stockBefore}）`)
        }
      }
    }
  },
})
