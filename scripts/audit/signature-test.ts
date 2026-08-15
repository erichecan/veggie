/**
 * 电子签收验收（台账 C5）
 * ============================================================================
 * 需求验收：手机端能签、能重签、能保存；后台行程页可查看签名；签名后状态正确流转。
 *
 * ⚠️ 「能重签」这一条实现得比需求**更严**，是有意的：签名一旦落库就不可变
 * （`PUT /api/trips/[id]` 整包覆盖 restaurants JSON，不拦的话任何一次后续保存
 * 都能把收货凭证换掉或抹掉）。要改只能走主管更正路径，且旧签名归档不销毁。
 * 所以这里把「重签」拆成两种：
 *   · 提交前在画布上反复画 —— 前端行为，随便重画
 *   · 提交后要改 —— 必须是主管，必须填原因，旧图必须留档
 * 本脚本验的是后者，因为那才是服务端的事。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npm run test:signature
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { MAX_SIGNATURE_BYTES } from '../../lib/trip-signature'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
// 口令收口在 _seed-credentials.ts —— 此前 26 个脚本各写一遍字面量，改一个账号要改 26 处
import { seedPassword } from './_seed-credentials'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const DRIVER = process.env.DRIVER_EMAIL ?? 'driver@veggie.com'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()

/** 一张真的 1x1 PNG（不是随便拼的 base64 —— 格式校验要能过） */
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 超过 200KB 上限的"签名" */
const PNG_HUGE = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_SIGNATURE_BYTES + 50 * 1024) * 4 / 3))}`

interface Restaurant {
  restaurantId: string; restaurantName?: string; orderIds?: string[]
  delivered?: boolean; signature?: string | null; signerName?: string | null; signedAt?: string | null
  signatureCorrections?: Array<{ previousSignature: string; reason: string; action: string; correctedByName: string }>
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

  const opToken = await login(OPERATOR)
  if (!opToken) { skip('登录', '运营账号登录失败'); return report() }
  const auth: Record<string, string> = { Authorization: `Bearer ${opToken}`, 'Content-Type': 'application/json' }
  const stamp = Date.now()

  const driverUser = await prisma.user.findUnique({ where: { email: DRIVER }, select: { id: true, name: true } })
  if (!driverUser) { skip('司机账号', `${DRIVER} 不存在`); return report() }
  const driverToken = await login(DRIVER)
  if (!driverToken) { skip('司机登录', '登录失败（限流？）'); return report() }
  const drvAuth: Record<string, string> = { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' }

  // 行程夹具：两站，都归这个司机
  const custA = await prisma.customer.create({
    data: { name: `C5 客户甲 ${stamp}`, isActive: true, paymentTerm: 'cash' }, select: { id: true, name: true },
  })
  const custB = await prisma.customer.create({
    data: { name: `C5 客户乙 ${stamp}`, isActive: true, paymentTerm: 'cash' }, select: { id: true, name: true },
  })
  const trip = await prisma.trip.create({
    data: {
      name: `C5 签收测试 ${stamp}`, driverId: driverUser.id, driverName: driverUser.name,
      status: 'IN_PROGRESS', totalPayment: 0,
      restaurants: [
        { restaurantId: custA.id, restaurantName: custA.name, orderIds: [], delivered: false, items: [], returns: [], pods: [] },
        { restaurantId: custB.id, restaurantName: custB.name, orderIds: [], delivered: false, items: [], returns: [], pods: [] },
      ] as never,
    },
    select: { id: true, restaurants: true },
  })

  const readTrip = async (): Promise<Restaurant[]> => {
    const t = await prisma.trip.findUnique({ where: { id: trip.id }, select: { restaurants: true } })
    return (t?.restaurants ?? []) as unknown as Restaurant[]
  }

  /** 司机端保存签名：整包 PUT restaurants，与真实前端一致 */
  const sign = async (
    restaurantId: string,
    over: Partial<Restaurant>,
    who: Record<string, string> = drvAuth,
  ) => {
    const list = await readTrip()
    const next = list.map(r => r.restaurantId === restaurantId ? { ...r, ...over } : r)
    return fetch(`${BASE}/api/trips/${trip.id}`, {
      method: 'PUT', headers: who, body: JSON.stringify({ restaurants: next }),
    })
  }

  // ── ① 能签、能保存 ────────────────────────────────────────────────────────
  const clientClaimedTime = '2020-01-01T00:00:00.000Z'   // 客户端谎报的时间
  const r1 = await sign(custA.id, {
    signature: PNG_1PX, signerName: '张经理', signedAt: clientClaimedTime, delivered: true,
  })
  const afterSign = await readTrip()
  const sigA = afterSign.find(r => r.restaurantId === custA.id)
  add('① 司机提交签名 → 保存成功', r1.ok && !!sigA?.signature,
    `HTTP ${r1.status} · 签收人 ${sigA?.signerName ?? '（无）'}`)

  add('① 签收时间由服务端打，不采纳客户端谎报的时间',
    !!sigA?.signedAt && sigA.signedAt !== clientClaimedTime && Math.abs(Date.parse(sigA.signedAt) - Date.now()) < 5 * 60_000,
    `客户端传 ${clientClaimedTime} · 库里 ${sigA?.signedAt ?? 'null'}`)

  add('① 签名后该站标记为已送达（状态正确流转）', sigA?.delivered === true,
    `delivered=${sigA?.delivered}`)

  // ── ② 后台能查到 ──────────────────────────────────────────────────────────
  const backOffice = await fetch(`${BASE}/api/trips/${trip.id}`, { headers: auth })
  const boBody = await backOffice.json() as { restaurants?: Restaurant[] }
  const boSig = (boBody.restaurants ?? []).find(r => r.restaurantId === custA.id)
  add('② 后台行程接口能取到签名图与签收人（需求：后台可查看）',
    backOffice.ok && !!boSig?.signature && boSig.signature === PNG_1PX && boSig.signerName === '张经理',
    `HTTP ${backOffice.status} · 图长度 ${boSig?.signature?.length ?? 0} · 签收人 ${boSig?.signerName ?? '（无）'}`)

  // ── ③ 签过就不许改（凭证不可被后续保存悄悄换掉）────────────────────────────
  const tamper = await sign(custA.id, { signature: PNG_1PX.replace('iVBOR', 'iVBOQ'), signerName: '李四' })
  const tamperBody = await tamper.json().catch(() => ({})) as { error?: string }
  const afterTamper = (await readTrip()).find(r => r.restaurantId === custA.id)
  add('③ 已签站点再次提交签名 → 409，且库里的原签名一个字节没变',
    tamper.status === 409 && afterTamper?.signature === PNG_1PX && afterTamper?.signerName === '张经理',
    `HTTP ${tamper.status} ${tamperBody.error ?? ''}`)

  const erase = await sign(custA.id, { signature: null, signerName: null })
  const afterErase = (await readTrip()).find(r => r.restaurantId === custA.id)
  add('③ 试图把签名置空同样挡下，凭证抹不掉',
    afterErase?.signature === PNG_1PX,
    `HTTP ${erase.status} · 库里签名仍在=${afterErase?.signature === PNG_1PX}`)

  // ── ④ 输入校验 ────────────────────────────────────────────────────────────
  const bad1 = await sign(custB.id, { signature: 'data:image/jpeg;base64,AAAA', signerName: '王五' })
  add('④ 非 PNG data URI → 400（不是 500）', bad1.status === 400, `HTTP ${bad1.status}`)

  const bad2 = await sign(custB.id, { signature: PNG_HUGE, signerName: '王五' })
  add('④ 超过 200KB 的图 → 400（签名列在 JSON 里，塞大图会撑爆整行）',
    bad2.status === 400, `HTTP ${bad2.status}`)

  const bad3 = await sign(custB.id, { signature: PNG_1PX })
  add('④ 有签名但没签收人姓名 → 400（光有一张画没有证明力）',
    bad3.status === 400, `HTTP ${bad3.status}`)

  const stillEmpty = (await readTrip()).find(r => r.restaurantId === custB.id)
  add('④ 三次非法提交之后，乙站依然是未签状态（没有半截数据落库）',
    !stillEmpty?.signature, `signature=${stillEmpty?.signature ? '有' : '无'}`)

  // ── ⑤ 主管更正：换签 ──────────────────────────────────────────────────────
  const noReason = await fetch(`${BASE}/api/trips/${trip.id}/signature-correction`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ restaurantId: custA.id, action: 'replace', signature: PNG_1PX, signerName: '赵六' }),
  })
  add('⑤ 更正不填原因 → 400（改凭证必须留下为什么）', noReason.status === 400, `HTTP ${noReason.status}`)

  const drvCorrect = await fetch(`${BASE}/api/trips/${trip.id}/signature-correction`, {
    method: 'POST', headers: drvAuth,
    body: JSON.stringify({ restaurantId: custA.id, action: 'void', reason: '司机自己想改' }),
  })
  add('⑤ 司机不能更正自己收的签名 → 403（职责分离）', drvCorrect.status === 403, `HTTP ${drvCorrect.status}`)

  const replaced = await fetch(`${BASE}/api/trips/${trip.id}/signature-correction`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      restaurantId: custA.id, action: 'replace', reason: '签错人，实际收货人是赵六',
      signature: PNG_1PX.replace('iVBOR', 'iVBOQ'), signerName: '赵六',
    }),
  })
  const afterReplace = (await readTrip()).find(r => r.restaurantId === custA.id)
  add('⑤ 主管换签成功，新签名与新签收人生效',
    replaced.ok && afterReplace?.signerName === '赵六' && afterReplace?.signature !== PNG_1PX,
    `HTTP ${replaced.status} · 签收人 ${afterReplace?.signerName ?? '（无）'}`)

  const corr = afterReplace?.signatureCorrections ?? []
  add('⑤ **旧签名归档而不是被覆盖掉**（凭证销毁了就没法举证）',
    corr.length === 1 && corr[0]!.previousSignature === PNG_1PX,
    `留档 ${corr.length} 条 · 原图还在=${corr[0]?.previousSignature === PNG_1PX}`)

  add('⑤ 留档里有谁改的、为什么改',
    !!corr[0]?.reason && !!corr[0]?.correctedByName,
    `${corr[0]?.correctedByName ?? '?'}：「${corr[0]?.reason ?? '?'}」`)

  // ── ⑥ 主管更正：作废 ──────────────────────────────────────────────────────
  const voided = await fetch(`${BASE}/api/trips/${trip.id}/signature-correction`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ restaurantId: custA.id, action: 'void', reason: '客户反悔，退回重送' }),
  })
  const afterVoid = (await readTrip()).find(r => r.restaurantId === custA.id)
  add('⑥ 作废后签名清空、该站退回未送达（状态跟着回退）',
    voided.ok && !afterVoid?.signature && afterVoid?.delivered === false,
    `HTTP ${voided.status} · signature=${afterVoid?.signature ? '有' : '无'} · delivered=${afterVoid?.delivered}`)

  const corr2 = afterVoid?.signatureCorrections ?? []
  add('⑥ 两次更正各留一条档，历史不被后一次冲掉',
    corr2.length === 2 && corr2[0]!.action === 'replace' && corr2[1]!.action === 'void',
    `留档 ${corr2.length} 条：${corr2.map(c => c.action).join(' → ')}`)

  // 作废之后可以重新签 —— 否则一次签错这一站就永远签不了
  const resign = await sign(custA.id, { signature: PNG_1PX, signerName: '重签的人', delivered: true })
  const afterResign = (await readTrip()).find(r => r.restaurantId === custA.id)
  add('⑥ 作废之后司机可以重新签（否则签错一次这一站就废了）',
    resign.ok && afterResign?.signerName === '重签的人',
    `HTTP ${resign.status} · 签收人 ${afterResign?.signerName ?? '（无）'}`)

  // 未签的站点不能"更正"
  const voidUnsigned = await fetch(`${BASE}/api/trips/${trip.id}/signature-correction`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ restaurantId: custB.id, action: 'void', reason: '试试' }),
  })
  add('⑥ 对没签过的站点做更正 → 409（不能凭空造一条更正记录）',
    voidUnsigned.status === 409, `HTTP ${voidUnsigned.status}`)

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  const sk = cases.filter(c => c.state === 'skip').length
  console.log('\n电子签收验收\n' + '='.repeat(78))
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
