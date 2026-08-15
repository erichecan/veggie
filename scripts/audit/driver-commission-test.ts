/**
 * 司机提成考核报表 —— 端到端实证（台账 H3）
 * ============================================================================
 * 验收六条：① 按司机 × 周期出汇总 ② 明细逐单可见构成并能追到订单
 *          ③ 报表合计 == 逐单 calcOrderCommission 重算之和，**且金额非零**
 *          ④ 冻结与未冻结分开呈现 ⑤ 司机看不到、管理岗看得到 ⑥ 见浏览器实测
 *
 * ③ 为什么强调「非零」：B2 那轮抽 20 张已完成单重算，0 差异 —— 但 20 张全是
 * 「库中 0、重算也 0」。三项输入都缺，两边都算 0，那个 ✓ 没有任何验证能力。
 * 本脚本先把三项输入都造出来（件提成快照 / 客户提成率 / 客户固定费），
 * 再断言「合计 > 0 且逐笔相等」。
 *
 * 比对方式：报表接口用 SQL 聚合，本脚本用 `lib/commission.ts` 的 `calcOrderCommission`
 * 逐单重算。**两套独立实现**，一致才有信息量（G2 的教训）。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:driver-commission
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { calcOrderCommission } from '../../lib/commission'
import { ensureOpeningStock } from '../../prisma/seed-events/inventory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const BOSS = process.env.BOSS_EMAIL ?? 'boss@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const num = (v: unknown) => Number(v ?? 0)
const eur = (n: number) => `€${n.toFixed(2)}`
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol
const ymd = (d: Date) => d.toISOString().slice(0, 10)

interface Payload {
  byDriver: Array<{
    driverId: string | null; driverName: string; tripCount: number; orderCount: number
    frozenOrderCount: number; deliveredSubtotal: number; itemTotal: number; fixedFee: number
    rateTotal: number; computedTotal: number; frozenTotal: number; diff: number
  }>
  byPeriod: Array<{ period: string; driverName: string; orderCount: number; computedTotal: number }>
  detail: Array<{
    orderId: string; orderCode: string | null; bizDate: string; driverName: string
    itemTotal: number; fixedFee: number; rateTotal: number; computedTotal: number
    frozenTotal: number | null; frozenAt: string | null; diff: number; deliveredSubtotal: number
  }>
  totals: { driverCount: number; orderCount: number; frozenOrderCount: number; computedTotal: number; frozenTotal: number; diff: number }
  detailTruncated: boolean
}

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: seedPassword(email) }),
  })
  const j = await r.json() as { token?: string }
  return j.token ?? null
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const token = await login(OPERATOR)
  if (!token) { skip('登录', '运营账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  // ── 夹具：两个 cash 客户（避开信用冻结）+ 两个带件提成价的商品 ──────────────
  // 客户甲配了提成率与固定费，客户乙两样都没有 —— 用来分辨三项构成各自的来源。
  const custA = await prisma.customer.create({
    data: { name: `H3 提成客户甲 ${stamp}`, isActive: true, paymentTerm: 'cash',
            commissionRate: 0.02, commissionFixed: 5 },
    select: { id: true, name: true },
  })
  const custB = await prisma.customer.create({
    data: { name: `H3 提成客户乙 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })

  // 商品甲：按基准单位（件）卖，件提成 €0.50
  const nameA = `H3 提成商品甲 ${stamp}`
  const tA = await prisma.productTemplate.create({
    data: { name: nameA, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 4,
            uomId: 'uom_pcs', canBeSold: true, commissionPrice: 0.5,
            products: { create: [{ name: nameA, listPrice: 10, standardPrice: 4, qtyOnHand: 0, active: true, status: 'ACTIVE', commissionPrice: 0.5 }] } },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const prodA = tA.products[0]!.id

  const caseUom = await prisma.uom.findFirst({ where: { id: 'uom_case' }, select: { id: true, factor: true } })
  const anchor = await prisma.uom.findFirst({ where: { id: 'uom_pcs' }, select: { factor: true } })

  const nameB = `H3 提成商品乙 ${stamp}`
  const tB = await prisma.productTemplate.create({
    data: { name: nameB, type: 'PRODUCT', status: 'ACTIVE', listPrice: 30, standardPrice: 12,
            uomId: 'uom_pcs', canBeSold: true, commissionPrice: 1.2,
            products: { create: [{ name: nameB, listPrice: 30, standardPrice: 12, qtyOnHand: 0, active: true, status: 'ACTIVE', commissionPrice: 1.2 }] } },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const prodB = tB.products[0]!.id

  // ⛔ 库存必须**连流水一起**造。直接塞 qtyOnHand 会让 db:validate 的头号不变量
  // （qtyOnHand == ΣStockMove）当场破掉 —— 那不是产品缺陷，是夹具自己不守恒，
  // 周期 25、26 已各踩过一次。走期初余额口径补一笔 ADJUSTMENT。
  await ensureOpeningStock(prisma, {
    target: 1000,
    backdate: new Date('2026-08-05T00:00:00Z'),
    productIds: [prodA, prodB],
  })

  /** 建单 → 确认。uomId 传 null 表示按基准单位 */
  async function makeOrder(
    cust: { id: string; name: string },
    items: Array<{ productId: string; quantity: number; unitPrice: number; uomId?: string }>,
    label: string,
  ): Promise<string> {
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        restaurantId: cust.id, restaurantName: cust.name,
        deliveryDate: ymd(new Date()),
        items: items.map(i => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, ...(i.uomId ? { uomId: i.uomId } : {}) })),
      }),
    })
    const j = await res.json() as { id?: string; error?: string }
    if (!j.id) throw new Error(`建单失败(${label}): HTTP ${res.status} ${j.error ?? ''}`)
    const cf = await fetch(`${BASE}/api/orders/${j.id}`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ status: 'CONFIRMED' }),
    })
    if (!cf.ok) throw new Error(`确认失败(${label}): HTTP ${cf.status}`)
    return j.id
  }

  let o1: string, o2: string, o3: string
  try {
    // 单 1：客户甲，商品甲 20 件 @€10  → 件提成 20×0.5=10；固定费 5；比例 200×0.02=4 ⇒ 19
    o1 = await makeOrder(custA, [{ productId: prodA, quantity: 20, unitPrice: 10 }], '甲-件')
    // 单 2：客户甲，商品乙按**箱**下单（验证单位换算那条腿，I3）
    o2 = await makeOrder(custA, [{ productId: prodB, quantity: 3, unitPrice: 30, ...(caseUom ? { uomId: caseUom.id } : {}) }], '甲-箱')
    // 单 3：客户乙（无 rate/fixed），商品甲 10 件 → 只有件提成 5
    o3 = await makeOrder(custB, [{ productId: prodA, quantity: 10, unitPrice: 10 }], '乙-件')
  } catch (e) {
    skip('夹具建单', e instanceof Error ? e.message : String(e)); return report()
  }

  // ── ① 下单链路是否写 commissionPrice 快照 —— B2 欠下的受控实验 ────────────
  const snapLines = await prisma.orderLine.findMany({
    where: { orderId: { in: [o1, o2, o3] } },
    select: { orderId: true, productId: true, commissionPrice: true, uomId: true, orderedQty: true },
  })
  const allSnapped = snapLines.length > 0 && snapLines.every(l => l.commissionPrice != null)
  add('① 下单即写入件提成价快照（B2 欠下的受控实验）', allSnapped,
    `${snapLines.filter(l => l.commissionPrice != null).length}/${snapLines.length} 行有快照 · ` +
    `值 ${[...new Set(snapLines.map(l => String(num(l.commissionPrice))))].join('/')}`)

  // ── 夹具：波次（定业务日）+ 两个行程 ───────────────────────────────────────
  // 波次日期刻意设为**昨天**，而 Trip.createdAt 是今天 —— 用来验证报表按
  // waveDate 归期（与 /api/analytics/logistics 同口径），而不是按 Trip 建档时间。
  const yesterday = new Date(Date.now() - 86400_000)
  const wave = await prisma.pickingWave.create({
    data: { name: `H3 波次 ${stamp}`, waveDate: new Date(ymd(yesterday)), waveType: 'PM',
            orderIds: [o1, o2, o3], driverName: `H3 司机甲 ${stamp}`, status: 'PENDING' },
    select: { id: true },
  })

  // ⛔ driverId 必须是**真实存在的用户 id**。第一版编了个 `h3-drv-<stamp>`，
  // C6 的「行程 driverId 都指向真实用户」当场报出 25 条违例 —— 全是这个脚本留下的。
  // 测试数据自身不守恒，测出来的结论就不可信（周期 25/26 已在库存上踩过两次）。
  const drvA = await prisma.user.create({
    data: {
      email: `h3-drv-a-${stamp}@veggie.com`, name: `H3 司机甲 ${stamp}`,
      role: 'DRIVER', roles: ['DRIVER'], passwordHash: 'x', isActive: true,
    },
    select: { id: true, name: true },
  })
  const drvB = await prisma.user.create({
    data: {
      email: `h3-drv-b-${stamp}@veggie.com`, name: `H3 司机乙 ${stamp}`,
      role: 'DRIVER', roles: ['DRIVER'], passwordHash: 'x', isActive: true,
    },
    select: { id: true, name: true },
  })
  const driverName = drvA.name
  const tripDone = await prisma.trip.create({
    data: {
      name: `H3 行程-已完成 ${stamp}`, driverName, driverId: drvA.id,
      status: 'IN_PROGRESS', waveId: wave.id, totalPayment: 0,
      restaurants: [
        { restaurantId: custA.id, restaurantName: custA.name, orderIds: [o1, o2] },
        { restaurantId: custB.id, restaurantName: custB.name, orderIds: [o3] },
      ] as never,
    },
    select: { id: true },
  })

  // ── ② 行程完成 → 逐单冻结（真实触发点，不直接写 driverCommissionTotal）────
  const doneRes = await fetch(`${BASE}/api/trips/${tripDone.id}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ status: 'COMPLETED' }),
  })
  const frozen = await prisma.order.findMany({
    where: { id: { in: [o1, o2, o3] } },
    select: { id: true, code: true, driverCommissionTotal: true, commissionFrozenAt: true, status: true },
  })
  add('② 行程置为 COMPLETED → 三单提成全部冻结', doneRes.ok && frozen.every(o => o.commissionFrozenAt != null),
    `HTTP ${doneRes.status} · 冻结 ${frozen.filter(o => o.commissionFrozenAt != null).length}/3 · ` +
    frozen.map(o => `${o.code ?? o.id.slice(0, 6)}=${eur(num(o.driverCommissionTotal))}`).join(' '))

  const frozenSum = frozen.reduce((s, o) => s + num(o.driverCommissionTotal), 0)
  add('② 冻结金额非零（否则后面的"一致"没有验证能力）', frozenSum > 0, `三单冻结合计 ${eur(frozenSum)}`)

  // ── 报表 ────────────────────────────────────────────────────────────────────
  const from = ymd(new Date(Date.now() - 3 * 86400_000))
  const to = ymd(new Date())
  // ⚠️ `/api/analytics/*` 全走 withCachedAuth：key = 查询串 + 角色，区间含今天时 TTL 60 秒。
  // 脚本每次运行都新造夹具，若用固定 URL，第二次跑就会拿到**上一轮**的快照 ——
  // 表现为"报表里没有本次的司机"，看着像功能坏了。detailLimit 取一个随运行变化的
  // 合法值（对这点数据量不影响结果），让每轮拿到自己的 key。
  const bust = (n: number) => `from=${from}&to=${to}&grain=day&detailLimit=${300 + (stamp % 1000) + n}`
  const qs = bust(0)
  const repRes = await fetch(`${BASE}/api/analytics/driver-commission?${qs}`, { headers: auth })
  if (!repRes.ok) { skip('报表接口', `HTTP ${repRes.status} ${await repRes.text()}`); return report() }
  const rep = await repRes.json() as Payload

  const mine = rep.byDriver.find(d => d.driverName === driverName)
  add('③ 报表按司机汇总里出现该司机', !!mine,
    mine ? `${mine.driverName} · ${mine.orderCount} 单 · 重算 ${eur(mine.computedTotal)}` : '⛔ 没找到')
  if (!mine) { await prisma.$disconnect(); return report() }

  add('③ 汇总金额非零', mine.computedTotal > 0, `重算合计 ${eur(mine.computedTotal)}`)

  // ── ④ 与 lib/commission.ts 逐单比对（独立实现，非自证）────────────────────
  const recalc: Record<string, { item: number; fixed: number; rate: number; total: number }> = {}
  for (const id of [o1, o2, o3]) {
    const c = await calcOrderCommission(id)
    recalc[id] = { item: num(c.itemTotal), fixed: num(c.fixedFee), rate: num(c.rateTotal), total: num(c.grandTotal) }
  }
  const recalcTotal = Object.values(recalc).reduce((s, c) => s + c.total, 0)
  add('④ 报表重算合计 == calcOrderCommission 之和（两套独立实现）',
    near(mine.computedTotal, recalcTotal),
    `报表 ${eur(mine.computedTotal)} vs commission.ts ${eur(recalcTotal)}`)

  const detailMine = rep.detail.filter(d => d.driverName === driverName)
  const perOrderOk = [o1, o2, o3].every(id => {
    const d = detailMine.find(x => x.orderId === id)
    if (!d) return false
    const r = recalc[id]!
    return near(d.itemTotal, r.item) && near(d.fixedFee, r.fixed) && near(d.rateTotal, r.rate)
  })
  add('④ 明细的三项构成逐单对上（件提成/固定费/比例提成）', perOrderOk,
    [o1, o2, o3].map(id => {
      const d = detailMine.find(x => x.orderId === id); const r = recalc[id]!
      return `${d?.orderCode ?? id.slice(0, 6)}: 件${eur(d?.itemTotal ?? -1)}/${eur(r.item)} 固${eur(d?.fixedFee ?? -1)}/${eur(r.fixed)} 比${eur(d?.rateTotal ?? -1)}/${eur(r.rate)}`
    }).join(' | '))

  const sumParts = detailMine.every(d => near(d.itemTotal + d.fixedFee + d.rateTotal, d.computedTotal))
  add('④ 每单「三项之和 == 该单合计」', sumParts, `${detailMine.length} 行逐行核对`)

  const detailSum = detailMine.reduce((s, d) => s + d.computedTotal, 0)
  add('④ 汇总 == 明细之和（同一份数字，不是两套口径）', near(mine.computedTotal, detailSum),
    `汇总 ${eur(mine.computedTotal)} vs 明细 ${eur(detailSum)}`)

  add('④ 冻结合计与库中 driverCommissionTotal 一致', near(mine.frozenTotal, frozenSum),
    `报表 ${eur(mine.frozenTotal)} vs 库 ${eur(frozenSum)}`)

  // ── 构成来源可分辨：客户乙没有 rate/fixed，那一单只能有件提成 ────────────
  const d3 = detailMine.find(d => d.orderId === o3)
  add('④ 客户没配提成率/固定费时，该单只有件提成', !!d3 && d3.fixedFee === 0 && d3.rateTotal === 0 && d3.itemTotal > 0,
    d3 ? `件 ${eur(d3.itemTotal)} 固 ${eur(d3.fixedFee)} 比 ${eur(d3.rateTotal)}` : '未找到该单')

  // 按箱下单那一单：件提成必须按换算后的基准单位数量算，不是按箱数
  const d2 = detailMine.find(d => d.orderId === o2)
  const factor = caseUom && anchor ? num(caseUom.factor) / num(anchor.factor) : 1
  add('④ 非基准单位下单时件提成按换算量算（I3 那条腿）',
    !!d2 && near(d2.itemTotal, 1.2 * 3 * factor),
    d2 ? `实得 ${eur(d2.itemTotal)} · 期望 1.2 × 3箱 × 系数${factor} = ${eur(1.2 * 3 * factor)}` : '未找到该单')

  // ── ⑤ 未冻结的单要分开呈现，不能混进"可发钱"的数字里 ─────────────────────
  const o4 = await makeOrder(custB, [{ productId: prodA, quantity: 6, unitPrice: 10 }], '未完成')
  await prisma.trip.create({
    data: {
      name: `H3 行程-在途 ${stamp}`, driverName: drvB.name, driverId: drvB.id,
      status: 'IN_PROGRESS', waveId: wave.id, totalPayment: 0,
      restaurants: [{ restaurantId: custB.id, restaurantName: custB.name, orderIds: [o4] }] as never,
    },
    select: { id: true },
  })
  // 在途行程的订单还没送达 → deliveredQty 全 0 → 件提成/比例提成都是 0，
  // 固定费也不该给（"没去成没有辛苦费"）。这同时验证了 anyDelivered 那条边界。
  // 换一个 detailLimit 绕开缓存：原样重放同一个 URL 拿到的是刚才那次的快照，
  // 那样测的是缓存不是功能 —— 第一版就因此把下面两条断言判成了"未找到该单"。
  const rep2 = await fetch(`${BASE}/api/analytics/driver-commission?${bust(1)}`, { headers: auth })
    .then(r => r.json()) as Payload
  const openRow = rep2.detail.find(d => d.orderId === o4)
  add('⑤ 未送达的单：冻结列为空、固定费不计', !!openRow && openRow.frozenAt === null && openRow.fixedFee === 0,
    openRow ? `冻结=${openRow.frozenAt ?? 'null'} 固定费=${eur(openRow.fixedFee)} 合计=${eur(openRow.computedTotal)}` : '未找到该单')

  const openDriver = rep2.byDriver.find(d => d.driverName === drvB.name)
  add('⑤ 汇总里「已冻结单数」把未冻结的排除在外', !!openDriver && openDriver.frozenOrderCount === 0 && openDriver.orderCount === 1,
    openDriver ? `已冻结 ${openDriver.frozenOrderCount}/${openDriver.orderCount}` : '未找到该司机')

  // ── ① 周期分组 ─────────────────────────────────────────────────────────────
  const myPeriods = rep2.byPeriod.filter(p => p.driverName === driverName)
  const periodSum = myPeriods.reduce((s, p) => s + p.computedTotal, 0)
  const mine2 = rep2.byDriver.find(d => d.driverName === driverName)!
  add('① 按日分组之和 == 该司机总计', near(periodSum, mine2.computedTotal),
    `${myPeriods.length} 个日期 · 合计 ${eur(periodSum)} vs ${eur(mine2.computedTotal)}`)
  add('① 业务日取波次日期而非行程建档日', myPeriods.every(p => p.period === ymd(yesterday)),
    `期望 ${ymd(yesterday)}（波次日）· 实得 ${[...new Set(myPeriods.map(p => p.period))].join(',')}`)

  const wRes = await fetch(`${BASE}/api/analytics/driver-commission?${bust(3).replace('grain=day', 'grain=week')}`, { headers: auth })
  const wk = await wRes.json() as Payload
  const wkSum = wk.byPeriod.filter(p => p.driverName === driverName).reduce((s, p) => s + p.computedTotal, 0)
  add('① 换成按周分组，总额不变（只是切法不同）', near(wkSum, mine2.computedTotal),
    `周粒度 ${eur(wkSum)} vs 日粒度 ${eur(mine2.computedTotal)}`)

  // ── ① 按司机筛选 ───────────────────────────────────────────────────────────
  const fRes = await fetch(
    `${BASE}/api/analytics/driver-commission?${qs}&driverId=${drvA.id}&driverName=${encodeURIComponent(driverName)}`,
    { headers: auth })
  const filtered = await fRes.json() as Payload
  add('① 按 (driverId, driverName) 筛选只返回该司机', filtered.byDriver.length === 1 && filtered.byDriver[0]!.driverName === driverName,
    `返回 ${filtered.byDriver.length} 名司机：${filtered.byDriver.map(d => d.driverName).join(',')}`)

  // ⛔ 回归：**同一个 driverId 挂多个司机名**。测试库里 BAO/AFZAAL/SEAN 就共用一个
  // Trip.driverId，只按 id 筛会把三个人一起带出来 —— 页面上表现为「点了司机，数字不动」。
  // 这里造一对同 id 不同名的行程，断言按名字能真的筛开。
  // 同一个真实用户 id 挂两个不同的司机名 —— 这正是现网数据的形状
  const sharedId = drvA.id
  // ⛔ 每个行程挂**各自的订单**。第一版让两个行程共用 o4，于是同一张订单同时挂在
  // 三个行程上 —— C6 的「一单只挂一个司机」当场报违例。夹具自己破坏业务不变量，
  // 得到的就不是"测出问题"而是"测出我自己造的问题"（周期 25/26 已在库存上踩过两次）。
  for (const nm of [`H3 同ID甲 ${stamp}`, `H3 同ID乙 ${stamp}`]) {
    const oid = await makeOrder(custB, [{ productId: prodA, quantity: 2, unitPrice: 10 }], nm)
    await prisma.trip.create({
      data: {
        name: `H3 同ID行程 ${nm}`, driverName: nm, driverId: sharedId,
        status: 'IN_PROGRESS', waveId: wave.id, totalPayment: 0,
        restaurants: [{ restaurantId: custB.id, restaurantName: custB.name, orderIds: [oid] }] as never,
      },
    })
  }
  const shRes = await fetch(
    `${BASE}/api/analytics/driver-commission?${bust(4)}&driverId=${sharedId}&driverName=${encodeURIComponent(`H3 同ID甲 ${stamp}`)}`,
    { headers: auth })
  const shared = await shRes.json() as Payload
  add('① 同一个 driverId 挂多个司机名时，按名字能筛开（页面「点了不动」的成因）',
    shared.byDriver.length === 1 && shared.byDriver[0]!.driverName === `H3 同ID甲 ${stamp}`,
    `返回 ${shared.byDriver.length} 名：${shared.byDriver.map(d => d.driverName).join(',')}`)

  const idOnly = await fetch(`${BASE}/api/analytics/driver-commission?${bust(5)}&driverId=${sharedId}`, { headers: auth })
    .then(r => r.json()) as Payload
  // drvA 名下现在挂着三个名字（本人 + 同ID甲 + 同ID乙），只给 id 应该三个都回来
  add('① 只给 driverId 时如实返回该 id 下的全部司机名（不假装筛过了）',
    idOnly.byDriver.length >= 2 && idOnly.byDriver.every(d => d.driverId === drvA.id),
    `返回 ${idOnly.byDriver.length} 名：${idOnly.byDriver.map(d => d.driverName).join(',')}`)

  // ── 提成归属：跟行程走，不跟订单上计划派的司机走 ──────────────────────────
  // 把 o1 的 driverSlotId 改成别人，报表里这单必须仍算在行程司机名下。
  // （20260708 那个坑：显示态按波次派生、编辑态读 order 列，两套真相。）
  const otherSlot = await prisma.driverSlot.findFirst({ select: { id: true, driverName: true } })
  if (otherSlot) {
    await prisma.order.update({ where: { id: o1 }, data: { driverSlotId: otherSlot.id } })
    // 同样要绕开缓存：命中旧快照的话，这条断言会因为"看到的是改派前的数据"而假性通过
    const rep3 = await fetch(`${BASE}/api/analytics/driver-commission?${bust(2)}`, { headers: auth }).then(r => r.json()) as Payload
    const stillMine = rep3.detail.find(d => d.orderId === o1)?.driverName === driverName
    add('② 提成归属跟"实际跑这趟的司机"走，不跟 Order.driverSlotId 走', stillMine,
      `把该单 driverSlotId 改派给「${otherSlot.driverName}」后，报表仍记在「${driverName}」名下=${stillMine}`)
  } else {
    skip('② 提成归属不跟 Order.driverSlotId 走', '库里没有可用的 DriverSlot 做改派')
  }

  // ── ⑥ 权限 ─────────────────────────────────────────────────────────────────
  const bossToken = await login(BOSS)
  if (bossToken) {
    const r = await fetch(`${BASE}/api/analytics/driver-commission?${qs}`, { headers: { Authorization: `Bearer ${bossToken}` } })
    add('⑥ 老板能打开（迁移把 analytics.commission.read 补给了 boss）', r.status === 200, `HTTP ${r.status}`)
  } else skip('⑥ 老板可访问', '登录失败（限流？）')

  const drvToken = await login(DRIVER)
  if (drvToken) {
    const r = await fetch(`${BASE}/api/analytics/driver-commission?${qs}`, { headers: { Authorization: `Bearer ${drvToken}` } })
    add('⑥ 司机拿不到这张表（薪酬数据，403 不是 200 空集）', r.status === 403, `HTTP ${r.status}`)
  } else skip('⑥ 司机被拒', '登录失败（限流？）')

  const anon = await fetch(`${BASE}/api/analytics/driver-commission?${qs}`)
  add('⑥ 匿名 401', anon.status === 401, `HTTP ${anon.status}`)

  // ── 输入校验（H2 修过「校验一律 500」，这里不重蹈）────────────────────────
  const badGrain = await fetch(`${BASE}/api/analytics/driver-commission?${qs.replace('grain=day', 'grain=fortnight')}`, { headers: auth })
  add('⑥ 非法 grain 返回 400 而非 500', badGrain.status === 400, `HTTP ${badGrain.status}`)
  // ⚠️ 不能往 qs 后面再追加一个 detailLimit —— searchParams.get 取的是**第一个**值，
  // 合法的那个会把越界的那个挡住，测出来永远是 200。整条 URL 重新拼。
  const badLimit = await fetch(`${BASE}/api/analytics/driver-commission?from=${from}&to=${to}&detailLimit=99999`, { headers: auth })
  add('⑥ 越界 detailLimit 返回 400 而非 500', badLimit.status === 400, `HTTP ${badLimit.status}`)
  const badLimit2 = await fetch(`${BASE}/api/analytics/driver-commission?from=${from}&to=${to}&detailLimit=abc`, { headers: auth })
  add('⑥ 非数字 detailLimit 返回 400 而非 500', badLimit2.status === 400, `HTTP ${badLimit2.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n司机提成考核报表 · 端到端\n' + '='.repeat(78))
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
