/**
 * 采购计划与预测 MVP —— 端到端实证
 * ============================================================================
 * 台账 F1。验收三条：
 *   ① 界面能列出建议采购商品与建议量
 *   ② 可人工改量
 *   ③ 一键生成采购单且行项目正确
 *
 * 建议量的公式（lib/purchase-suggestions-fresh.ts）：
 *   max(0, 近3日日均出货 + 已确认未来订单 − 现有库存 − 在途采购)
 * 光看「有没有生成建议」证明不了它算得对，所以这里**把四个输入都造成已知值**，
 * 再断言输出恰好等于手算结果 —— 建议量算错比没有建议更糟，采购会照着它下单。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:purchase-suggestion
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: seedPassword(OPERATOR) }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

const dayAt = (offset: number) => {
  const d = new Date()
  d.setUTCHours(12, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offset)
  return d
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const token = await login()
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  // ── 前提：品类分组必须存在，否则生鲜建议生成器直接返回空数组 ────────────
  const group = await prisma.categoryGroup.findUnique({ where: { key: 'FRESH_FROZEN' } })
  add('前提：FRESH_FROZEN 品类分组存在', !!group,
    group ? `groupId=${group.id}` : '⛔ CategoryGroup 空 —— 采购建议会恒为空（见 db:bootstrap 第 5 步）')
  if (!group) { await prisma.$disconnect(); return report() }

  const category = await prisma.productCategory.findFirst({ where: { groupId: group.id }, select: { id: true, name: true } })
  if (!category) { skip('准备类目', '该分组下没有商品类目'); await prisma.$disconnect(); return report() }

  const supplier = await prisma.customer.findFirst({ where: { isVendor: true }, select: { id: true, name: true } })
  if (!supplier) { skip('准备供应商', '测试库没有供应商'); await prisma.$disconnect(); return report() }

  // ── 夹具：四个输入全部造成已知值 ────────────────────────────────────────
  //   近3日已送达 30 → 日均 10 ；未来已确认 25 ；现有库存 10 ；在途 5
  //   建议量 = max(0, 10 + 25 − 10 − 5) = 20
  const pname = `F1 采购建议测试商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 12, standardPrice: 5,
      uomId: 'uom_pcs', canBeSold: true, canBePurchased: true, categoryId: category.id,
      products: { create: [{ name: pname, listPrice: 12, standardPrice: 5, qtyOnHand: 0, active: true, status: 'ACTIVE', categoryId: category.id }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const productId = tmpl.products[0]!.id
  await prisma.$transaction([
    prisma.stockMove.create({
      data: {
        productId, productName: pname, type: 'ADJUSTMENT', qty: 10, movedAt: new Date(),
        note: 'F1 期初', sourceType: 'TEST_OPENING', sourceRef: 'F1',
      },
    }),
    prisma.product.update({ where: { id: productId }, data: { qtyOnHand: 10 } }),
  ])
  await prisma.productSupplierInfo.create({
    data: { productId, supplierId: supplier.id, price: 5, sequence: 1 },
  })

  const cust = await prisma.customer.create({
    data: { name: `F1 采购建议测试客户 ${stamp}`, paymentTerm: 'cash', isCustomer: true, isActive: true },
    select: { id: true, name: true },
  })

  // 近 3 日已送达 30（昨天送达的一张 COMPLETED 单）
  await prisma.order.create({
    data: {
      code: `F1-SO-A-${stamp}`, restaurantId: cust.id, restaurantName: cust.name,
      status: 'COMPLETED', items: [], totalAmount: 360,
      quotationDate: dayAt(-1), deliveryDate: dayAt(-1), confirmationDate: dayAt(-1),
      lines: { create: [{ productId, productName: pname, unitPrice: 12, orderedQty: 30, deliveredQty: 30, subtotal: 360 }] },
    },
  })
  // 未来已确认 25（明天交付的一张 CONFIRMED 单）
  await prisma.order.create({
    data: {
      code: `F1-SO-B-${stamp}`, restaurantId: cust.id, restaurantName: cust.name,
      status: 'CONFIRMED', items: [], totalAmount: 300,
      quotationDate: dayAt(0), deliveryDate: dayAt(1), confirmationDate: dayAt(0),
      lines: { create: [{ productId, productName: pname, unitPrice: 12, orderedQty: 25, deliveredQty: 0, subtotal: 300 }] },
    },
  })
  // 在途采购 5（订 8 已收 3 的 CONFIRMED 采购单）
  await prisma.purchaseOrder.create({
    data: {
      name: `F1-PO-${stamp}`, supplierId: supplier.id, status: 'CONFIRMED',
      orderDate: new Date(), expectedDate: dayAt(1),
      subtotalExTax: 40, totalTax: 0, totalIncTax: 40,
      lines: {
        create: [{
          productId, productName: pname, orderedQty: 8, receivedQty: 3,
          unitCost: 5, unitCostEur: 5, taxRate: 0, subtotalExTax: 40, taxAmount: 0, subtotalIncTax: 40,
        }],
      },
    },
  })
  add('夹具就位：出货 30/3日 · 未来 25 · 库存 10 · 在途 5', true, '期望建议量 = 10 + 25 − 10 − 5 = 20')

  // ── ① 生成建议并核对建议量 ──────────────────────────────────────────────
  const gen = await fetch(`${BASE}/api/purchase-suggestions/generate-fresh`, { method: 'POST', headers: auth })
  const genBody = await gen.json() as { generated?: number; suggestions?: Array<{ productId: string; suggestedQty: number; dailyAvgOutbound: number; futureDemand: number; currentStock: number; inTransitQty: number; reason: string }> }
  add('① 生成生鲜每日建议', gen.status === 201 && (genBody.generated ?? 0) > 0,
    `HTTP ${gen.status} · 生成 ${genBody.generated ?? 0} 条`)

  const mine = genBody.suggestions?.find(s => s.productId === productId)
  add('① 四个输入逐项还原（不是只看有没有生成）',
    !!mine && mine.dailyAvgOutbound === 10 && mine.futureDemand === 25 && mine.currentStock === 10 && mine.inTransitQty === 5,
    mine ? `日均 ${mine.dailyAvgOutbound} · 未来 ${mine.futureDemand} · 库存 ${mine.currentStock} · 在途 ${mine.inTransitQty}` : '⛔ 建议里没有该商品')
  add('① 建议量 = 20（手算值）', mine?.suggestedQty === 20,
    `suggestedQty=${mine?.suggestedQty ?? '—'}（应 20）· ${mine?.reason ?? ''}`)

  // 列表接口（界面读的就是它）
  const listed = await (await fetch(`${BASE}/api/purchase-suggestions?status=pending&limit=500`, { headers: auth })).json() as
    { items?: Array<{ id: string; productId: string; suggestedQty: string | number; supplierId: string | null }> } | Array<{ id: string; productId: string; suggestedQty: string | number; supplierId: string | null }>
  const rows = Array.isArray(listed) ? listed : (listed.items ?? [])
  const row = rows.find(r => r.productId === productId)
  add('① 建议出现在列表接口里（界面据此渲染）', !!row,
    row ? `建议 id=${row.id} · 建议量 ${num(row.suggestedQty)} · 供应商 ${row.supplierId ? '已带出' : '(空)'}` : '⛔ 列表里没有')
  if (!row) { await prisma.$disconnect(); return report() }

  // ── ②③ 人工改量后一键转采购单 ───────────────────────────────────────────
  const MANUAL_QTY = 12    // 采购员把 20 改成 12
  const conv = await fetch(`${BASE}/api/purchase-suggestions/${row.id}/convert`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      qty: MANUAL_QTY, supplierId: supplier.id, supplierName: supplier.name,
      unitCost: 5, taxRate: 0, notes: 'F1 端到端',
    }),
  })
  const convBody = await conv.json() as { purchaseOrder?: { id: string; name: string } } & Record<string, unknown>
  const poId = convBody.purchaseOrder?.id ?? (convBody as { id?: string }).id
  add('③ 一键转采购单', conv.status === 200 || conv.status === 201,
    `HTTP ${conv.status} · PO ${convBody.purchaseOrder?.name ?? '(未返回单号)'}`)

  const po = poId
    ? await prisma.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
    : await prisma.purchaseOrder.findFirst({ where: { lines: { some: { productId } }, name: { not: `F1-PO-${stamp}` } }, include: { lines: true }, orderBy: { createdAt: 'desc' } })
  const poLine = po?.lines.find(l => l.productId === productId)
  add('③ 采购单行项正确：商品 / 数量 / 单价 / 小计',
    !!poLine && num(poLine.orderedQty) === MANUAL_QTY && num(poLine.unitCost) === 5 && num(poLine.subtotalExTax) === 60,
    poLine ? `qty=${num(poLine.orderedQty)}（应 ${MANUAL_QTY}）· unitCost=${num(poLine.unitCost)} · 小计=${num(poLine.subtotalExTax)}（应 60）` : '⛔ 采购单里没有该商品行')
  add('② 采纳的是人工改后的量，不是原建议量',
    !!poLine && num(poLine.orderedQty) === MANUAL_QTY && num(poLine.orderedQty) !== 20,
    `下单 ${num(poLine?.orderedQty)} vs 建议 20`)
  add('③ 采购单挂到正确供应商', po?.supplierId === supplier.id, `supplierId=${po?.supplierId ?? '—'}`)

  const sugAfter = await prisma.purchaseSuggestion.findUnique({ where: { id: row.id } })
  add('③ 建议状态转为 ordered 并关联采购单',
    sugAfter?.status === 'ordered' && !!sugAfter?.purchaseOrderId,
    `status=${sugAfter?.status} purchaseOrderId=${sugAfter?.purchaseOrderId ? '已关联' : '(空)'}`)
  // 数量改了，金额必须跟着改：否则列表上会出现「建议采购 12 · 预估成本 €100」这种
  // 自相矛盾的行（€100 是按原建议 20 算的）—— 浏览器走查时肉眼发现的
  add('③ 采纳后建议量与预估成本同步改写（不能只改一个）',
    num(sugAfter?.suggestedQty) === MANUAL_QTY && num(sugAfter?.estimatedCost) === MANUAL_QTY * 5,
    `suggestedQty=${num(sugAfter?.suggestedQty)} · estimatedCost=${num(sugAfter?.estimatedCost)}（应 ${MANUAL_QTY * 5}）`)

  // 重复转单必须被挡（否则一条建议能生出好几张采购单）
  const again = await fetch(`${BASE}/api/purchase-suggestions/${row.id}/convert`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ qty: 1, supplierId: supplier.id, unitCost: 5 }),
  })
  add('③ 同一条建议不能重复转单', again.status === 400, `HTTP ${again.status}（应 400）`)

  // ── 幂等：再生成一次，已转单的建议不该被复活或重复 ──────────────────────
  const gen2 = await fetch(`${BASE}/api/purchase-suggestions/generate-fresh`, { method: 'POST', headers: auth })
  const gen2Body = await gen2.json() as { generated?: number; suggestions?: Array<{ productId: string; suggestedQty: number }> }
  const orderedStill = await prisma.purchaseSuggestion.findUnique({ where: { id: row.id } })
  const dupPending = await prisma.purchaseSuggestion.count({
    where: { productId, status: 'pending', categoryGroupKey: 'FRESH_FROZEN' },
  })
  add('重复生成不复活已转单的建议', orderedStill?.status === 'ordered', `原建议仍为 ${orderedStill?.status}`)
  add('重复生成不产生重复 pending（同商品至多 1 条）', dupPending <= 1,
    `该商品 pending 建议 ${dupPending} 条 · 本次生成 ${gen2Body.generated ?? 0} 条`)

  // 转单后在途 +12 → 建议量应相应减少（证明公式真的在用在途数据）
  const mine2 = gen2Body.suggestions?.find(s => s.productId === productId)
  add('转单后在途增加，建议量随之下降', !mine2 || mine2.suggestedQty < 20,
    mine2 ? `新建议量 ${mine2.suggestedQty}（原 20，在途 +12 后应更低）` : '该商品已无需补货（建议量归零，合理）')

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 采购计划与预测 MVP ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(40)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
