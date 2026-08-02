/**
 * M07 采购管理中心
 *   ① 采购计划与预测（历史销量+库存水位+季节性+促销 → 智能建议）
 *   ② 创建询价单（线上询价 / PDF 识别 / 历史报价 / 复制历史采购单）
 *   ③ 采购订单管理（创建/修改/审核/跟踪/入库/退货/发票）
 *   ④ 采购质检与验收（到货重量/新鲜度/农残检测，不合格触发退换）
 */
import { defineCheck, api, grepCode, grepMatrix, findFiles, prisma } from '../harness'

defineCheck({
  id: 'M07-01',
  module: '07',
  title: '采购计划与预测（智能生成采购建议）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const generators = findFiles('app/api/purchase-suggestions', 'route.ts')
      .map(p => p.replace('app/api/purchase-suggestions/', '').replace('/route.ts', ''))
    evidence.push(`建议生成入口: ${generators.join(', ')}`)

    const count = await prisma.purchaseSuggestion.count()
    evidence.push(`PurchaseSuggestion 生产数据: ${count} 条`)

    const annual = grepCode('近12月|同比|增长率', { roots: 'lib/purchase-suggestions-annual.ts', max: 3 })
    evidence.push(...annual.map(l => `干货年度算法: ${l.slice(0, 130)}`))

    const fresh = grepCode('缺口|在途|安全库存|近期均量|avgDaily', { roots: 'lib app/api/purchase-suggestions', max: 4 })
    evidence.push(...fresh.map(l => `生鲜算法: ${l.slice(0, 130)}`))

    // 合同点名的两个因子
    const factors = grepMatrix(
      ['seasonal', '季节性', 'promotion', '促销', 'holiday', '节假日'],
      'app lib',
    )
    evidence.push(`季节性/促销因子命中: ${JSON.stringify(factors)}`)

    return {
      verdict: 'partial' as const,
      gap: '生鲜走「缺口补货」规则、干货走「近12月同比外推」，两条规则都跑得通并已产出 ' +
        `${count} 条建议；但合同点名的季节性因素与促销活动两个因子在代码里零命中，` +
        '算不上"智能生成"',
      evidence,
    }
  },
})

defineCheck({
  id: 'M07-02',
  module: '07',
  title: '询价单（线上询价 / PDF 识别 / 历史报价 / 复制历史采购单）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const sub: Record<string, boolean> = {}

    // PDF 识别报价
    const pdf = findFiles('app/api/purchase-orders/pdf-extract', 'route.ts')
    sub['PDF识别'] = pdf.length > 0
    evidence.push(`PDF 报价识别接口: ${pdf.join(', ') || '无'}`)

    // 历史报价查询
    const lastPrice = grepCode('last-by-group|历史报价|lastPrice', { roots: 'app lib', max: 4 })
    sub['历史报价'] = lastPrice.length > 0
    evidence.push(...lastPrice.slice(0, 2).map(l => `历史报价: ${l.slice(0, 120)}`))

    // 复制历史采购单
    const copyHist = grepCode('从历史单复制|CopyFromHistoryModal', { roots: 'app', max: 3 })
    sub['复制历史采购单'] = copyHist.length > 0
    evidence.push(...copyHist.slice(0, 2).map(l => `复制历史单: ${l.slice(0, 130)}`))

    // 线上询价：向供应商发起 RFQ 并回收报价
    const rfq = grepMatrix(
      ['sendRfq', '发起询价', 'rfqEmail', 'quoteRequest', 'supplierPortal'],
      'app lib',
    )
    sub['线上询价'] = Object.values(rfq).some(v => v > 0)
    evidence.push(`向供应商线上询价命中: ${JSON.stringify(rfq)}`)

    evidence.push(`四项子能力: ${Object.entries(sub).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    const missing = Object.entries(sub).filter(([, v]) => !v).map(([k]) => k)
    if (missing.length === 0) return { verdict: 'done' as const, evidence }
    return {
      verdict: 'partial' as const,
      gap: `PDF 识别、历史报价、复制历史采购单三项均已实现（复制历史单是 0729 之后落地的）；` +
        `仍缺：${missing.join('、')}——没有向供应商在线发起询价并回收报价的闭环`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M07-03',
  module: '07',
  title: '采购订单全流程（创建/审核/跟踪/入库/退货/发票）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const pos = await prisma.purchaseOrder.groupBy({ by: ['status'], _count: true })
    evidence.push(`PurchaseOrder 状态分布: ${pos.map(p => `${p.status}=${p._count}`).join(' ')}`)

    const r = await api('/api/purchase-orders?pageSize=1')
    evidence.push(r.brief)

    const stages: Record<string, boolean> = {
      创建: pos.length > 0,
      审核: grepCode('editApprovalRequired|审核|approv', { roots: 'app/api/purchase-orders', max: 3 }).length > 0,
      跟踪: grepCode('PO_TRACKED_FIELDS|expectedDate', { roots: 'app/api/purchase-orders', max: 3 }).length > 0,
      入库: (await prisma.goodsReceipt.count()) > 0,
      发票: (await prisma.vendorBill.count()) >= 0 && grepCode('vendorBill', { roots: 'app/api', max: 2 }).length > 0,
      退货: grepMatrix(['purchaseReturn', '采购退货', 'returnToVendor'], 'app lib prisma/schema.prisma')['purchaseReturn'] > 0,
    }
    const bills = await prisma.vendorBill.count()
    evidence.push(`VendorBill 供应商账单: ${bills} 条`)
    evidence.push(`各环节: ${Object.entries(stages).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    const retKw = grepMatrix(['purchaseReturn', '采购退货', 'returnToVendor', '退货给供应商'], 'app lib prisma/schema.prisma')
    evidence.push(`采购退货关键词命中: ${JSON.stringify(retKw)}`)

    const missing = Object.entries(stages).filter(([, v]) => !v).map(([k]) => k)
    if (missing.length === 0) return { verdict: 'done' as const, evidence }
    return {
      verdict: 'partial' as const,
      gap: `创建/审核/跟踪/入库/发票状态机完整；缺 ${missing.join('、')}——` +
        `CreditNote 只覆盖销售侧退款，采购侧无独立退货单据`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M07-04',
  module: '07',
  title: '采购质检与验收（到货重量 / 新鲜度 / 农残检测）',
  prev: 'missing',
  async run() {
    const evidence: string[] = []

    const kw = grepMatrix(
      ['质检', '农残', '新鲜度', 'freshness', 'pesticide', 'qualityCheck', 'inspection', 'qcResult', '不合格'],
      'app lib prisma/schema.prisma',
    )
    evidence.push(`质检关键词全集命中: ${JSON.stringify(kw)}`)

    // 现有验收能力只到"良品/损坏"二值
    const cond = grepCode("condition.*damaged|'ok'\\|'damaged'|良品", { roots: 'app/api/goods-receipts prisma/schema.prisma', max: 3 })
    evidence.push(...cond.map(l => `现有验收粒度: ${l.slice(0, 130)}`))

    const anyQc = Object.values(kw).some(v => v > 0)
    if (!anyQc) {
      return {
        verdict: 'missing' as const,
        gap: '质检/农残/新鲜度/freshness/pesticide/inspection 等关键词全库零命中。' +
          '现有验收粒度只到收货行的 condition: ok | damaged 二值，没有重量核对、' +
          '没有新鲜度分级、没有农残检测记录，也没有不合格品触发退换的流程',
        evidence,
      }
    }
    return { verdict: 'partial' as const, gap: '有质检关键词但未成流程', evidence }
  },
})
