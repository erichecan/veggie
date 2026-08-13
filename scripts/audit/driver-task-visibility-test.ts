/**
 * 任务接收链路：配送中心指派 → 司机端可见（台账 C4）
 * ============================================================================
 * 需求验收三条：
 *   ① 操作员分配 + 确认出发 → 司机账号刷新后看到该单
 *   ② 未指派给他的单看不到
 *   ③ 改派后旧司机端该单消失
 *
 * ②「看不到」必须是**服务端拿不到**，不是前端没渲染。司机端页面调的是
 * `/api/trips?driverId=<自己的id>` —— 那个 id 是查询参数，换一个就能看别人的，
 * 不传则拿到全公司的。所以这里专门用「司机拿着别人的 id 去问」来验，
 * 而不是看页面上有没有显示。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:driver-tasks
 */
import bcrypt from 'bcryptjs'
import { createPrismaClient } from '../../lib/prisma-factory'
import { ensureOpeningStock } from '../../prisma/seed-events/inventory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()
const ymd = (d: Date) => d.toISOString().slice(0, 10)

interface TripRow { id: string; driverId: string | null; driverName: string | null; waveId: string | null }

async function login(email: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string }
  return j.token ?? null
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }

  const opToken = await login(OPERATOR)
  if (!opToken) { skip('登录', '运营账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${opToken}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  const driverUser = await prisma.user.findUnique({ where: { email: DRIVER }, select: { id: true, name: true } })
  if (!driverUser) { skip('司机账号', `${DRIVER} 不存在`); return report() }

  // 第二个司机账号 —— ②「看不到别人的」需要一个真正的"别人"。
  // 直接建到库里（含 RBAC 绑定），走登录接口拿 token，不用 signToken 抄近路。
  const driverRole = await prisma.appRole.findUnique({ where: { code: 'driver' }, select: { id: true } })
  const otherEmail = `c4-driver-${stamp}@veggie.com`
  const otherUser = await prisma.user.create({
    data: {
      email: otherEmail, name: `C4 司机乙 ${stamp}`, role: 'DRIVER', roles: ['DRIVER'],
      passwordHash: await bcrypt.hash(PASSWORD, 12), isActive: true,
      ...(driverRole ? { roleLinks: { create: [{ roleId: driverRole.id }] } } : {}),
    },
    select: { id: true, name: true },
  })

  // ── 夹具：两个司机档位 + 一个商品 ──────────────────────────────────────────
  const slotA = await prisma.driverSlot.create({
    data: { timeOfDay: 'am', batchNum: 4, driverName: `C4 甲 ${stamp}`, userId: null },
    select: { id: true, driverName: true },
  })
  const slotB = await prisma.driverSlot.create({
    data: { timeOfDay: 'am', batchNum: 5, driverName: `C4 乙 ${stamp}`, userId: otherUser.id },
    select: { id: true, driverName: true },
  })

  const cust = await prisma.customer.create({
    data: { name: `C4 测试客户 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })
  const pname = `C4 测试商品 ${stamp}`
  const tmpl = await prisma.productTemplate.create({
    data: {
      name: pname, type: 'PRODUCT', status: 'ACTIVE', listPrice: 10, standardPrice: 4,
      uomId: 'uom_pcs', canBeSold: true,
      products: { create: [{ name: pname, listPrice: 10, standardPrice: 4, qtyOnHand: 0, active: true, status: 'ACTIVE' }] },
    },
    select: { products: { select: { id: true }, take: 1 } },
  })
  const productId = tmpl.products[0]!.id
  // 库存连流水一起造 —— 直接塞 qtyOnHand 会破坏 db:validate 的头号不变量
  await ensureOpeningStock(prisma, { target: 500, backdate: new Date('2026-08-05T00:00:00Z'), productIds: [productId] })

  async function makeOrder(label: string): Promise<string> {
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        restaurantId: cust.id, restaurantName: cust.name,
        deliveryDate: ymd(new Date()),
        items: [{ productId, quantity: 5, unitPrice: 10 }],
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

  /** 走真实接口把订单分配到某个司机档位（= 调度台拖拽做的事） */
  async function assign(orderId: string, slotId: string) {
    return fetch(`${BASE}/api/orders/${orderId}/batch`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ driverSlotId: slotId }),
    })
  }

  async function waveOf(orderId: string) {
    return prisma.pickingWave.findFirst({
      where: { orderIds: { has: orderId } },
      select: { id: true, driverSlotId: true, driverName: true, dispatchedAt: true },
    })
  }

  async function dispatch(waveId: string) {
    return fetch(`${BASE}/api/waves/${waveId}/dispatch`, { method: 'PUT', headers: auth, body: '{}' })
  }

  // ── ① 档位没绑账号时会怎样 —— 这是**当前生产数据的真实状态** ──────────────
  // 库里 3 个 DriverSlot 的 userId 全为空，而 createTripFromWave 的司机身份
  // 取自 `slot.userId`。没绑 → Trip.driverId = null → 司机端按自己的 id 查，
  // 一条也查不到。功能没坏，是**主数据没配**，但结果对司机是一样的：看不到任务。
  let o1: string
  try { o1 = await makeOrder('未绑账号') } catch (e) {
    skip('夹具建单', e instanceof Error ? e.message : String(e)); return report()
  }
  const a1 = await assign(o1, slotA.id)
  const w1 = await waveOf(o1)
  if (!w1) { skip('分配到波次', `HTTP ${a1.status}，订单没进任何波次`); return report() }
  const d1 = await dispatch(w1.id)
  const t1 = await prisma.trip.findFirst({ where: { waveId: w1.id }, select: { id: true, driverId: true } })
  add('① 档位未绑系统账号 → 生成的行程 driverId 为空（司机端必然看不到）',
    d1.ok && !!t1 && t1.driverId === null,
    `确认出发 HTTP ${d1.status} · 行程 ${t1?.id.slice(0, 8) ?? '未生成'} · driverId=${t1?.driverId ?? 'null'}`)

  // ── ② 绑了账号：分配 + 确认出发 → 司机端真的看得到 ────────────────────────
  let o2: string
  try { o2 = await makeOrder('已绑账号') } catch (e) {
    skip('夹具建单2', e instanceof Error ? e.message : String(e)); return report()
  }
  await assign(o2, slotB.id)
  const w2 = await waveOf(o2)
  if (!w2) { skip('分配到波次2', '订单没进任何波次'); return report() }
  const d2 = await dispatch(w2.id)
  const t2 = await prisma.trip.findFirst({ where: { waveId: w2.id }, select: { id: true, driverId: true } })
  add('② 档位绑了账号 → 行程 driverId = 该司机的用户 id',
    d2.ok && t2?.driverId === otherUser.id,
    `确认出发 HTTP ${d2.status} · driverId=${t2?.driverId ?? 'null'} · 期望 ${otherUser.id}`)

  const otherToken = await login(otherEmail)
  if (!otherToken) { skip('司机乙登录', '登录失败（限流？）'); return report() }
  const otherAuth = { Authorization: `Bearer ${otherToken}` }

  const mine = await fetch(`${BASE}/api/trips?driverId=${otherUser.id}`, { headers: otherAuth })
    .then(r => r.json()) as TripRow[]
  add('② 司机端刷新后看到这一趟（需求验收原文：司机账号刷新后看到该单）',
    Array.isArray(mine) && mine.some(t => t.id === t2?.id),
    `司机乙的任务列表 ${Array.isArray(mine) ? mine.length : '?'} 条，含本趟=${Array.isArray(mine) && mine.some(t => t.id === t2?.id)}`)

  // ── ③ 未指派给他的看不到 —— 服务端层面，不是前端没渲染 ────────────────────
  const allForOther = Array.isArray(mine) ? mine : []
  add('③ 司机端列表里没有一条不属于自己的行程',
    allForOther.length > 0 && allForOther.every(t => t.driverId === otherUser.id),
    `${allForOther.length} 条，driverId 全等于本人=${allForOther.every(t => t.driverId === otherUser.id)}`)

  // 拿别人的 id 去问 —— driverId 是查询参数，前端的自觉挡不住任何人
  const peek = await fetch(`${BASE}/api/trips?driverId=${driverUser.id}`, { headers: otherAuth })
    .then(r => r.json()) as TripRow[]
  add('③ 司机拿**别人的 driverId** 去查，拿不到别人的行程',
    Array.isArray(peek) && peek.every(t => t.driverId === otherUser.id),
    `返回 ${Array.isArray(peek) ? peek.length : '?'} 条，其中属于他人的 ${Array.isArray(peek) ? peek.filter(t => t.driverId !== otherUser.id).length : '?'} 条`)

  // 干脆不带参数 —— 原实现返回全公司的行程
  const noParam = await fetch(`${BASE}/api/trips`, { headers: otherAuth }).then(r => r.json()) as TripRow[]
  add('③ 司机**不带 driverId** 时也只拿到自己的（原实现返回全公司）',
    Array.isArray(noParam) && noParam.every(t => t.driverId === otherUser.id),
    `返回 ${Array.isArray(noParam) ? noParam.length : '?'} 条，其中属于他人的 ${Array.isArray(noParam) ? noParam.filter(t => t.driverId !== otherUser.id).length : '?'} 条`)

  // 详情：列表挡住了但详情没挡的话，拿到 id 依然能逐条读走
  const otherTrip = await prisma.trip.findFirst({
    where: { driverId: driverUser.id }, select: { id: true },
  })
  if (otherTrip) {
    const peekOne = await fetch(`${BASE}/api/trips/${otherTrip.id}`, { headers: otherAuth })
    add('③ 司机按 id 直接读别人的行程详情 → 404（列表挡住而详情没挡等于没挡）',
      peekOne.status === 404, `HTTP ${peekOne.status}`)
  } else skip('③ 详情越权读', '库里没有属于其他司机的行程可用于对照')

  // 自己的详情仍要读得到 —— 隔离不能把司机自己挡在门外
  if (t2) {
    const own = await fetch(`${BASE}/api/trips/${t2.id}`, { headers: otherAuth })
    add('③ 司机读自己的行程详情正常（隔离没有误伤本人）', own.status === 200, `HTTP ${own.status}`)
  }

  // 管理岗不受这层影响
  const opAll = await fetch(`${BASE}/api/trips`, { headers: auth }).then(r => r.json()) as TripRow[]
  add('③ 运营看全部行程不受影响', Array.isArray(opAll) && opAll.length > allForOther.length,
    `运营 ${Array.isArray(opAll) ? opAll.length : '?'} 条 vs 司机 ${allForOther.length} 条`)

  // ── ④ 改派 ────────────────────────────────────────────────────────────────
  // 出发**前**改派：订单从甲的波次挪到乙的波次，出发后只应出现在乙那边。
  let o3: string
  try { o3 = await makeOrder('改派') } catch (e) {
    skip('夹具建单3', e instanceof Error ? e.message : String(e)); return report()
  }
  await assign(o3, slotA.id)
  const beforeWave = await waveOf(o3)
  await assign(o3, slotB.id)
  const afterWave = await waveOf(o3)
  add('④ 出发前改派：订单离开原司机的波次，进入新司机的波次',
    !!afterWave && afterWave.id !== beforeWave?.id && afterWave.driverSlotId === slotB.id,
    `${beforeWave?.driverName ?? '?'} → ${afterWave?.driverName ?? '?'}`)

  const stillInOld = await prisma.pickingWave.findUnique({
    where: { id: beforeWave!.id }, select: { orderIds: true },
  })
  add('④ 原波次里已经没有这一单（不是两边都挂着）',
    !((stillInOld?.orderIds as string[]) ?? []).includes(o3),
    `原波次剩 ${((stillInOld?.orderIds as string[]) ?? []).length} 单`)

  // 出发**后**改派：不允许脏写（已生成行程、司机已在路上）
  const d3 = await dispatch(afterWave!.id)
  const reassignAfter = await assign(o3, slotA.id)
  const body3 = await reassignAfter.json().catch(() => ({})) as { error?: string }
  add('④ 出发后再改派被挡下（409），不会出现"两个司机都拿着同一单"',
    reassignAfter.status === 409,
    `确认出发 HTTP ${d3.status} · 改派 HTTP ${reassignAfter.status} ${body3.error ?? ''}`)
  add('④ 拒绝的理由说人话（不是无信息的"分配批次失败"）',
    /已出发/.test(body3.error ?? ''),
    `错误文案：${body3.error ?? '（空）'}`)

  // 销售单 PUT 是改派的**另一条路径**，同一条规则不能两种表现。
  // 实测它本来就对：有一道更早的按订单状态判的守卫，409 且文案清楚。
  // （本轮给它补的 WaveDispatchedError 捕获是兜底，走不到 —— 如实记下来，
  //   不要把"我修好的"和"本来就好的"混为一谈。）
  const putAfter = await fetch(`${BASE}/api/orders/${o3}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ driverSlotId: slotA.id }),
  })
  const putBody = await putAfter.json().catch(() => ({})) as { error?: string }
  add('④ 销售单 PUT 这条改派路径同样是 409 且文案说得清（本来就对，非本轮修复）',
    putAfter.status === 409 && /不可改派|已出发/.test(putBody.error ?? ''),
    `HTTP ${putAfter.status} ${putBody.error ?? ''}`)

  const t3 = await prisma.trip.findFirst({ where: { waveId: afterWave!.id }, select: { driverId: true } })
  add('④ 改派后的这一单，行程归属的是新司机',
    t3?.driverId === otherUser.id,
    `行程 driverId=${t3?.driverId ?? 'null'} · 期望 ${otherUser.id}（${slotB.driverName}）`)

  // 收尾：把本轮造的档位归档。不归档的话每跑一次就在「司机配置」页多两行垃圾，
  // 而且 bind-driver-slots 会当真去给它们建账号（第一次跑就撞上了）。
  // 归档而不是删除 —— PickingWave.driverSlotId 还指着它们，删了会断引用。
  await prisma.driverSlot.updateMany({
    where: { id: { in: [slotA.id, slotB.id] } },
    data: { archived: true },
  })

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n任务接收链路：指派 → 司机端可见\n' + '='.repeat(78))
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
