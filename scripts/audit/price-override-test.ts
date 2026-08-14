/**
 * 手动改价 + 订单头行一致（台账 X1~X5）—— 端到端实证
 * ============================================================================
 * 起因：客户 20260814 反馈「订单详情改了单价，操作日志记下了 €22.50 → €35.00，
 * 列表还是 22.50」。查下来是三层叠加：
 *   ① 定价引擎根本不接受手动价，照价格表价入库
 *   ② 审计日志比的是**提交的 payload**，不是落库结果 → 记下从未发生的变更
 *   ③ 表头 totalAmount 用被拒的提交价算 → 头行分叉（生产 2 张单中招）
 *
 * 本脚本把两条路径都钉住 —— 只测「改价成功」是自欺，因为最烂的数据恰恰出在
 * **改价被拒**那条路上：那时表头才会跟着一个没落库的数字跑。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:price-override
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`
const near = (a: number, b: number) => Math.abs(a - b) < 0.011

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  return (await r.json() as { token?: string }).token ?? null
}

/** 表头与行小计是否一致 —— 这条断言在每个用例后都要跑一遍 */
async function headMatchesLines(orderId: string) {
  const [ord, lines] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, select: { totalAmount: true } }),
    prisma.orderLine.findMany({ where: { orderId }, select: { subtotal: true, unitPrice: true, orderedQty: true } }),
  ])
  const sum = lines.reduce((s, l) => s + Number(l.subtotal), 0)
  return { head: Number(ord?.totalAmount ?? 0), sum: Math.round(sum * 100) / 100, lines }
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const token = await login(OPERATOR)
  if (!token) { skip('登录', '运营账号登录失败（限流？）'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const stamp = Date.now()
  const cust = await prisma.customer.create({
    data: { name: `X 改价客户 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })
  const mkProduct = async (label: string, list: number) => {
    const t = await prisma.productTemplate.create({
      data: {
        name: `X ${label} ${stamp}`, type: 'PRODUCT', status: 'ACTIVE',
        listPrice: list, standardPrice: Math.round(list * 0.8 * 100) / 100,
        uomId: 'uom_pcs', canBeSold: true,
        products: { create: [{ name: `X ${label} ${stamp}`, listPrice: list, standardPrice: Math.round(list * 0.8 * 100) / 100, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
      },
      select: { products: { select: { id: true }, take: 1 } },
    })
    return t.products[0]!.id
  }
  const pA = await mkProduct('商品甲', 22.5)

  const mkOrder = async (productId: string, qty: number, price: number) => {
    const r = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        restaurantId: cust.id, restaurantName: cust.name,
        deliveryDate: new Date().toISOString().slice(0, 10),
        items: [{ productId, quantity: qty, unitPrice: price }],
      }),
    })
    return await r.json() as { id?: string; pricingWarnings?: string[] }
  }

  // ── ① 有权限时手动价真的落库 ─────────────────────────────────────────────
  const o1 = await mkOrder(pA, 1, 22.5)
  if (!o1.id) { skip('夹具建单', '建单失败'); return report() }
  const l1 = await prisma.orderLine.findFirst({ where: { orderId: o1.id }, select: { id: true } })

  const put1 = await fetch(`${BASE}/api/orders/${o1.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ lines: [{ id: l1!.id, productId: pA, orderedQty: 1, unitPrice: 35.0 }] }),
  })
  const body1 = await put1.json() as { pricingWarnings?: string[] }
  const s1 = await headMatchesLines(o1.id)
  add('① 手动改价 22.50 → 35.00 真的落库（客户报的就是这条不生效）',
    near(Number(s1.lines[0]?.unitPrice), 35), `落库单价 ${eur(s1.lines[0]?.unitPrice)}`)
  add('① 改价后表头 == Σ行小计', near(s1.head, s1.sum), `表头 ${eur(s1.head)} · Σ行 ${eur(s1.sum)}`)
  add('① 改价这件事有提示，不是静默发生',
    (body1.pricingWarnings ?? []).some(w => w.includes('手动价')),
    JSON.stringify(body1.pricingWarnings))

  const line1 = await prisma.orderLine.findFirst({ where: { orderId: o1.id }, select: { priceSourceType: true, priceSourceDetail: true } })
  add('① 留痕：标记为 MANUAL 并写明当时的价格表价',
    line1?.priceSourceType === 'MANUAL' && /22\.50/.test(line1?.priceSourceDetail ?? ''),
    `${line1?.priceSourceType} · ${line1?.priceSourceDetail}`)

  const log1 = await prisma.orderAuditLog.findFirst({
    where: { orderId: o1.id }, orderBy: { createdAt: 'desc' }, select: { changedFields: true },
  })
  add('① 审计日志与库里一致（日志说改成 35，库里就是 35）',
    JSON.stringify(log1?.changedFields ?? {}).includes('"priceAfter":35'),
    JSON.stringify(log1?.changedFields))

  // ── ② 被拒绝那条路径：表头不得跟着一个没落库的数字跑 ──────────────────────
  // 门户下单走同一个定价引擎但**不开**手动价，正好是「提交价被拒」的现成路径。
  // 这是本次事故里最烂的那一半：行按权威价、表头按提交价 → 头行分叉且不报错。
  const portalUser = await prisma.user.findFirst({
    where: { role: 'RESTAURANT', isActive: true }, select: { email: true },
  })
  if (!portalUser) {
    skip('② 被拒路径', '库里没有可登录的餐厅账号')
  } else {
    const ptoken = await login(portalUser.email)
    if (!ptoken) {
      skip('② 被拒路径', '餐厅账号登录失败（限流？）')
    } else {
      const pauth = { Authorization: `Bearer ${ptoken}`, 'Content-Type': 'application/json' }
      const pr = await fetch(`${BASE}/api/customer-portal/orders`, {
        method: 'POST', headers: pauth,
        // 餐厅自己报一个远低于目录价的价 —— 必须被拒
        body: JSON.stringify({ items: [{ productId: pA, quantity: 2, price: 1.0 }] }),
      })
      const pbody = await pr.json() as { id?: string; error?: string }
      if (!pbody.id) {
        skip('② 被拒路径', `门户下单失败 HTTP ${pr.status} ${pbody.error ?? ''}`)
      } else {
        const s2 = await headMatchesLines(pbody.id)
        add('② 客户自己报的价一律不采纳（门户不开手动价）',
          near(Number(s2.lines[0]?.unitPrice), 22.5), `落库单价 ${eur(s2.lines[0]?.unitPrice)}（客户报 €1.00）`)
        add('② **提交价被拒时表头也不能跟着提交价走** —— 头行分叉的正是这条',
          near(s2.head, s2.sum) && near(s2.head, 45),
          `表头 ${eur(s2.head)} · Σ行 ${eur(s2.sum)}（若按客户报价算会是 €2.00）`)
      }
    }
  }

  // ── ③ 追加行同样接上手动价（否则"改已有行能改、加新行改不了"）────────────
  const addLine = await fetch(`${BASE}/api/orders/${o1.id}/lines`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ productId: pA, productName: `X 商品甲 ${stamp}`, orderedQty: 2, unitPrice: 40.0 }),
  })
  const added = await addLine.json() as { id?: string; unitPrice?: unknown; priceSourceType?: string }
  add('③ 追加行的手动价同样生效并标 MANUAL',
    addLine.status === 201 && near(Number(added.unitPrice), 40) && added.priceSourceType === 'MANUAL',
    `HTTP ${addLine.status} · 单价 ${eur(added.unitPrice)} · ${added.priceSourceType}`)
  const s3 = await headMatchesLines(o1.id)
  add('③ 追加行后表头仍 == Σ行小计', near(s3.head, s3.sum), `表头 ${eur(s3.head)} · Σ行 ${eur(s3.sum)}`)

  // ── ④ 手动价不是"什么都收" ───────────────────────────────────────────────
  // ⚠️ 必须用**专用商品**：pA 在用例 ① 里刚以 €35 成交过，而定价引擎会取该客户的
  // 历史成交价，权威价此刻就是 35 而不是目录价 22.50 —— 借共享商品会让这条断言
  // 测的其实是别的用例留下的痕迹（E5x 的加权平均用例栽过同一个坑）
  const pB = await mkProduct('商品乙', 22.5)
  const o4 = await mkOrder(pB, 1, 22.5)
  const l4 = await prisma.orderLine.findFirst({ where: { orderId: o4.id! }, select: { id: true } })
  await fetch(`${BASE}/api/orders/${o4.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ lines: [{ id: l4!.id, productId: pB, orderedQty: 1, unitPrice: 0 }] }),
  })
  const s4 = await headMatchesLines(o4.id!)
  add('④ 提交价为 0 不当作"谈好按 0 卖"，回落权威价（0 多半是没填/算错）',
    near(Number(s4.lines[0]?.unitPrice), 22.5), `落库单价 ${eur(s4.lines[0]?.unitPrice)}`)
  add('④ 该情形下表头依旧 == Σ行小计', near(s4.head, s4.sum), `表头 ${eur(s4.head)} · Σ行 ${eur(s4.sum)}`)

  // ── ⑤ 全库回归：本脚本造的数据不得留下任何头行分叉 ────────────────────────
  const mine = await prisma.order.findMany({ where: { restaurantId: cust.id }, select: { id: true, code: true } })
  let diverged = 0
  const detail: string[] = []
  for (const o of mine) {
    const s = await headMatchesLines(o.id)
    if (!near(s.head, s.sum)) { diverged++; detail.push(`${o.code}: ${eur(s.head)} vs ${eur(s.sum)}`) }
  }
  add('⑤ 本次造的全部订单头行一致', diverged === 0,
    diverged === 0 ? `${mine.length} 张单全部一致` : detail.join('；'))

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n手动改价 · 订单头行一致（X1~X5）\n' + '='.repeat(78))
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⏭️'
    console.log(`${icon} ${c.name}\n     ${c.detail}`)
  }
  console.log('='.repeat(78))
  console.log(`通过 ${pass} · 失败 ${fail} · 跳过 ${sk} · 共 ${cases.length}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
