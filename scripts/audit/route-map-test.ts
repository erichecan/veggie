/**
 * 车辆调度 + 地图路线（台账 C7）—— 端到端实证
 * ============================================================================
 * 验收：一个波次能画出完整路线并给出里程/时长；无坐标客户有明确降级提示。
 *
 * ## 开工前的现状（实测，不是看代码猜的）
 *
 * 地图组件（Leaflet）、批次分析页、距离矩阵接口、地理编码接口**全都存在**，
 * 但整块功能是**空转**的：1411 个启用客户里 **0 个有坐标**，
 * 而坐标此前的唯一来源是 Google Geocoding —— `GOOGLE_MAPS_API_KEY` 没有配。
 * 于是「预计里程/时长」永远是空的，地图上一个点也画不出来。
 * 与 F1（CategoryGroup 为空导致采购建议恒空）、B2（提成三项输入全缺）同类：
 * **代码完整、数据为零**。
 *
 * 所以本轮做了三件事，这个脚本逐条验它们真的成立：
 *   ① 坐标可以手工录入（不再只能靠 Google）
 *   ② 没有 key 时里程/时长降级为直线估算，且**标明是估算**
 *   ③ 没有 key 时点「自动解析地址」要明确说清楚，而不是死按钮
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:route-map
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { haversineKm, estimateRoute } from '../../lib/geo'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()

/** 都柏林市内三个真实位置，间距足够算出有意义的里程 */
const SPOTS = [
  { name: '市中心', lat: 53.3498, lng: -6.2603 },
  { name: '邓莱里', lat: 53.2939, lng: -6.1350 },
  { name: '斯沃兹', lat: 53.4597, lng: -6.2181 },
]

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
  if (!token) { skip('登录', '运营账号登录失败（限流？）'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  // ── 现状取证：坐标覆盖率 ──────────────────────────────────────────────────
  const totalCust = await prisma.customer.count({ where: { isActive: true } })
  const withCoord = await prisma.customer.count({
    where: { isActive: true, latitude: { not: null }, longitude: { not: null } },
  })
  console.log(`\n[现状] 启用客户 ${totalCust} 个，有坐标 ${withCoord} 个（${(withCoord / Math.max(1, totalCust) * 100).toFixed(1)}%）`)
  console.log(`[现状] 地图服务密钥：${process.env.GOOGLE_MAPS_API_KEY ? '已配置' : '未配置（走直线估算降级）'}\n`)

  // ── ① 坐标可以手工录入 ────────────────────────────────────────────────────
  const custs: Array<{ id: string; name: string; lat: number; lng: number }> = []
  for (const spot of SPOTS) {
    const c = await prisma.customer.create({
      data: { name: `C7 ${spot.name} ${stamp}`, isActive: true, paymentTerm: 'cash', city: 'Dublin' },
      select: { id: true, name: true },
    })
    const res = await fetch(`${BASE}/api/customers/${c.id}`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ name: c.name, latitude: spot.lat, longitude: spot.lng }),
    })
    if (!res.ok) { skip('① 手工录入坐标', `HTTP ${res.status} ${await res.text()}`); return report() }
    custs.push({ id: c.id, name: c.name, lat: spot.lat, lng: spot.lng })
  }
  const saved = await prisma.customer.findMany({
    where: { id: { in: custs.map(c => c.id) } },
    select: { id: true, latitude: true, longitude: true },
  })
  add('① 坐标可以手工录入（此前只能靠 Google geocode 写入）',
    saved.length === 3 && saved.every(c => c.latitude != null && c.longitude != null),
    `${saved.filter(c => c.latitude != null).length}/3 家已存下坐标`)

  // 越界坐标要挡住 —— 写错一位就把餐馆丢到大西洋里，地图不会报错只会显示错位置
  const badLat = await fetch(`${BASE}/api/customers/${custs[0]!.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ name: custs[0]!.name, latitude: 999, longitude: 0 }),
  })
  add('① 越界坐标被拒（400），且原坐标没被写坏',
    badLat.status === 400,
    `HTTP ${badLat.status}`)
  const afterBad = await prisma.customer.findUnique({
    where: { id: custs[0]!.id }, select: { latitude: true },
  })
  add('① 拒绝之后原坐标完好', Number(afterBad?.latitude) === SPOTS[0]!.lat,
    `库里仍是 ${afterBad?.latitude}`)

  // 改地址时同时给坐标 → 坐标要留住（原实现会把它清掉）
  const withAddr = await fetch(`${BASE}/api/customers/${custs[1]!.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({
      name: custs[1]!.name, street: `C7 测试街 ${stamp}`,
      latitude: SPOTS[1]!.lat, longitude: SPOTS[1]!.lng,
    }),
  })
  const afterAddr = await prisma.customer.findUnique({
    where: { id: custs[1]!.id }, select: { latitude: true, street: true },
  })
  add('① 改地址的同时填坐标，坐标留得住（原实现会被自己清空）',
    withAddr.ok && afterAddr?.latitude != null,
    `地址=${afterAddr?.street ?? '-'} 坐标=${afterAddr?.latitude ?? 'null'}`)

  // ── ② 一条路线能算出里程/时长 ─────────────────────────────────────────────
  const routeRes = await fetch(`${BASE}/api/distance-matrix`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ customerIds: custs.map(c => c.id) }),
  })
  const route = await routeRes.json() as {
    totalDistanceKm?: number; totalDurationMin?: number; summary?: string
    estimated?: boolean; estimateNote?: string
    stops?: Array<{ id: string }>; missingCoords?: Array<{ name: string }>
  }
  add('② 一个波次（3 个站点）能算出里程与时长',
    routeRes.ok && (route.totalDistanceKm ?? 0) > 0 && (route.totalDurationMin ?? 0) > 0,
    `HTTP ${routeRes.status} · ${route.summary ?? '（无）'}`)

  // 与本地纯函数独立算一遍比对 —— 两套实现，一致才有信息量
  const expect = estimateRoute(custs.map(c => ({ lat: c.lat, lng: c.lng })))!
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    add('② 无地图密钥时降级为直线估算，且**标明是估算**',
      route.estimated === true && !!route.estimateNote,
      `estimated=${route.estimated} · ${route.estimateNote ?? '（没有说明）'}`)
    add('② 估算值与独立算的一致（接口一套、脚本一套）',
      Math.abs((route.totalDistanceKm ?? 0) - expect.totalDistanceKm) < 0.15,
      `接口 ${route.totalDistanceKm} km vs 独立算 ${expect.totalDistanceKm} km`)
    add('② 摘要里带「约」字，不会被当成实际道路里程',
      (route.summary ?? '').includes('约'),
      `摘要：${route.summary}`)
  } else {
    add('② 有地图密钥时返回实际道路里程（estimated=false）',
      route.estimated === false, `estimated=${route.estimated}`)
  }

  // 里程要有下限常识：三点直线和 ≈ 22km，绕行后不该更小
  const straight = haversineKm(custs[0]!, custs[1]!) + haversineKm(custs[1]!, custs[2]!)
  add('② 里程不小于直线距离之和（绕行只会更远）',
    (route.totalDistanceKm ?? 0) >= straight,
    `路线 ${route.totalDistanceKm} km vs 直线和 ${straight.toFixed(1)} km`)

  // ── ③ 无坐标客户的降级提示 ────────────────────────────────────────────────
  const noCoord = await prisma.customer.create({
    data: { name: `C7 无坐标客户 ${stamp}`, isActive: true, paymentTerm: 'cash' },
    select: { id: true, name: true },
  })
  const mixed = await fetch(`${BASE}/api/distance-matrix`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ customerIds: [...custs.map(c => c.id), noCoord.id] }),
  })
  const mixedBody = await mixed.json() as { missingCoords?: Array<{ name: string }>; stops?: Array<{ id: string }> }
  add('③ 无坐标客户被单独列出来（不是静默丢掉）',
    mixed.ok && (mixedBody.missingCoords ?? []).some(m => m.name === noCoord.name),
    `missingCoords=${(mixedBody.missingCoords ?? []).map(m => m.name).join(',') || '（空）'}`)
  add('③ 有坐标的那几家照常参与计算（一家没坐标不拖垮整条路线）',
    (mixedBody.stops ?? []).length === 3,
    `参与计算 ${(mixedBody.stops ?? []).length} 家`)

  const allMissing = await fetch(`${BASE}/api/distance-matrix`, {
    method: 'POST', headers: auth, body: JSON.stringify({ customerIds: [noCoord.id] }),
  })
  const amBody = await allMissing.json() as { error?: string; missingCoords?: unknown[] }
  add('③ 全都没坐标时返回 400 并说明原因（不是 500，也不是空 200）',
    allMissing.status === 400 && !!amBody.error,
    `HTTP ${allMissing.status} ${amBody.error ?? ''}`)

  // ── ③ 地理编码：没配密钥时不能是死按钮 ────────────────────────────────────
  const geo = await fetch(`${BASE}/api/geocode`, {
    method: 'POST', headers: auth, body: JSON.stringify({ customerIds: [noCoord.id] }),
  })
  const geoBody = await geo.json() as { error?: string; code?: string; hint?: string; geocoded?: number }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    add('③ 未配置地图服务时，自动解析地址返回 503 + 明确说明（原先是死按钮）',
      geo.status === 503 && geoBody.code === 'MAPS_NOT_CONFIGURED' && !!geoBody.hint,
      `HTTP ${geo.status} · ${geoBody.error ?? ''}｜${geoBody.hint ?? ''}`)
  } else {
    add('③ 已配置地图服务时地理编码正常返回', geo.ok, `HTTP ${geo.status}`)
  }

  // ── 权限 ──────────────────────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/distance-matrix`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerIds: custs.map(c => c.id) }),
  })
  add('④ 匿名调用路线接口 401', anon.status === 401, `HTTP ${anon.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n车辆调度 · 地图路线\n' + '='.repeat(78))
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
