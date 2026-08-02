/**
 * M04 司机绩效与 CMS 分析（补充需求）
 *   Product Commission + Customer Commission（Rate 比例制 + Fixed 固定制）
 * M14 Odoo 数据平移与导出
 *   一次性平移客户名册、产品 SKU 与历史价格
 */
import { defineCheck, grepCode, prisma } from '../harness'
import { calcOrderCommission } from '../../../lib/commission'

defineCheck({
  id: 'M04-01',
  module: '04',
  title: 'Product Commission + Customer Commission（Rate + Fixed）',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    const entry = grepCode('export async function', { roots: 'lib/commission.ts', max: 8 })
    evidence.push(`lib/commission.ts 唯一计算入口，导出 ${entry.length} 个函数`)

    // 两种客户提成模式的数据面
    const [rateSet, fixedSet, prodPriced] = await Promise.all([
      prisma.customer.count({ where: { commissionRate: { not: null } } }),
      prisma.customer.count({ where: { commissionFixed: { not: null } } }),
      prisma.product.count({ where: { commissionPrice: { not: null } } }),
    ])
    evidence.push(`客户 Rate 模式 ${rateSet} 个、Fixed 模式 ${fixedSet} 个；商品提成价 ${prodPriced} 个`)

    // 提成基准是 deliveredQty——必须挑真正已发货的单，否则算出来恒为 0
    const sample = await prisma.order.findFirst({
      where: {
        lines: { some: { commissionPrice: { not: null }, deliveredQty: { gt: 0 } } },
      },
      select: { id: true, code: true, driverCommissionTotal: true, commissionFrozenAt: true },
      orderBy: { createdAt: 'desc' },
    })
    if (sample) {
      const c = await calcOrderCommission(sample.id)
      evidence.push(
        `实算已发货订单 ${sample.code}: 商品提成=${c.itemTotal} 固定费=${c.fixedFee} ` +
        `比例提成=${c.rateTotal} 合计=${c.grandTotal}`,
      )
      evidence.push(
        `冻结快照: driverCommissionTotal=${sample.driverCommissionTotal ?? 'null'} ` +
        `frozenAt=${sample.commissionFrozenAt ?? 'null'}`,
      )
    } else {
      evidence.push('库里没有「带商品提成价 且 已发货」的订单行，三块金额无法实算')
    }

    const frozen = await prisma.order.count({ where: { commissionFrozenAt: { not: null } } })
    const completedTrips = await prisma.trip.count({ where: { status: 'COMPLETED' } })
    evidence.push(`已冻结提成快照的订单 ${frozen} 单；已完成行程 ${completedTrips} 个`)

    const engineOk = !!sample && prodPriced > 0
    if (engineOk && frozen > 0) return { verdict: 'done' as const, evidence }
    return {
      verdict: 'partial' as const,
      gap: `计算引擎与两种模式均已建模（Rate ${rateSet} 客户 / Fixed ${fixedSet} 客户 / 商品提成价 ${prodPriced} 个），` +
        `但生产上冻结快照 ${frozen} 单、已完成行程 ${completedTrips} 个——` +
        `结算链路从未真正跑过，绩效考核尚无实际产出`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M14-01',
  module: '14',
  title: '客户名册、产品 SKU、历史价格一次性平移',
  prev: 'done',
  async run() {
    const evidence: string[] = []

    const [customers, templates, products, orders, lines, pricelists, plItems] = await Promise.all([
      prisma.customer.count(),
      prisma.productTemplate.count(),
      prisma.product.count(),
      prisma.order.count(),
      prisma.orderLine.count(),
      prisma.odooPricelist.count(),
      prisma.customerPricelist.count(),
    ])
    evidence.push(
      `实际库存量：客户 ${customers}、商品模板 ${templates}、变体 ${products}、` +
      `订单 ${orders}、订单行 ${lines}、价格表 ${pricelists}、客户↔价格表 ${plItems}`,
    )
    evidence.push('0729 报告声称：客户 1,529 / 商品 1,718 SKU / 一周 789 单 / 6,995 行')

    // externalRef 在 Order 上，是 Odoo 原始单号的来源标记
    const extOrders = await prisma.order.count({ where: { externalRef: { not: null } } })
    evidence.push(`带 externalRef（Odoo 原始单号）的订单: ${extOrders} / ${orders}`)

    const importScripts = grepCode('import-odoo', { roots: 'scripts', max: 8 })
    evidence.push(`Odoo 导入脚本 ${importScripts.length} 个（客户/商品/价格表/订单/发票/分类/供应商）`)

    // 历史价格是否真的能取到
    const withPrice = await prisma.orderLine.count({ where: { unitPrice: { gt: 0 } } })
    evidence.push(`带成交价的历史订单行: ${withPrice}`)

    const ok = customers > 1000 && products > 1000 && lines > 5000
    return ok
      ? {
          verdict: 'done' as const,
          gap: `实际平移量远超 0729 报告口径：订单 ${orders} 单 / ${lines} 行（报告只提到一周 789 单）`,
          evidence,
        }
      : { verdict: 'partial' as const, gap: '平移量不足', evidence }
  },
})
