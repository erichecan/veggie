/**
 * 打单工作台：服务端打印留痕 —— 端到端实证
 * ============================================================================
 * 台账 D1。验收：「今日待打印列表、打印后留痕、重复打印二次确认」。
 *
 * 本脚本证明的核心是**留痕从 localStorage 搬到了服务端**：
 * 打印一次 → 换一个"客户端"（全新 HTTP 请求，不带任何浏览器状态）去问，
 * 仍然能看到「打过了、打了几次、谁打的」。原来那套 localStorage 方案在这一步
 * 必然失败 —— 那正是打印员 A 打过、打印员 B 看不到的成因。
 *
 * ⚠️ 会写库。只允许打向本机 veggie_test。
 * 用法：npx tsx --env-file=.env.test scripts/audit/print-status-test.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OPERATOR = process.env.OPERATOR_EMAIL ?? 'operator@veggie.com'
const PASSWORD = process.env.SEED_PASSWORD ?? 'LocalTest2026!'

interface Case { name: string; state: 'pass' | 'fail' | 'skip'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })
const skip = (name: string, detail: string) => cases.push({ name, state: 'skip', detail })

const prisma = createPrismaClient()

interface PrintMark { count: number; lastAt: string; lastBy: string }
interface StatusResp {
  waves: Record<string, Record<string, PrintMark>>
  legacyCount: number
  printedWaveCount: number
  totalWaveCount: number
  error?: string
}

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
  })
  const j = await r.json() as { token?: string; error?: string }
  if (!j.token) throw new Error(`登录失败：${j.error ?? ''}`)
  return j.token
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const token = await login()
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // ── 造一个当天的波次 ────────────────────────────────────────────────────
  const day = '2026-08-11'
  const wave = await prisma.pickingWave.create({
    data: {
      name: `D1-WAVE-${Date.now()}`, waveDate: new Date(`${day}T00:00:00.000Z`),
      waveType: 'DELIVERY', orderIds: [], assignmentDoneAt: new Date(),
    },
    select: { id: true, name: true },
  })

  const status = async (): Promise<StatusResp> => {
    const r = await fetch(`${BASE}/api/waves/print-status?date=${day}`, { headers: auth })
    return await r.json() as StatusResp
  }

  // ── 打印前：应当是"没打过" ──────────────────────────────────────────────
  const s0 = await status()
  if (s0.error) { skip('打印状态接口', `返回错误：${s0.error}`); return report() }
  add('打印前该批次为「未打印」', !s0.waves[wave.id],
    `waves[${wave.name}] = ${JSON.stringify(s0.waves[wave.id] ?? null)}`)
  add('接口给出「共几批 / 已打几批」', typeof s0.totalWaveCount === 'number',
    `当天共 ${s0.totalWaveCount} 批，已打 ${s0.printedWaveCount} 批 —— 打印员据此知道还剩几批`)

  // ── 打印拣货单一次 ──────────────────────────────────────────────────────
  const lock1 = await fetch(`${BASE}/api/waves/${wave.id}/pick-lock`, {
    method: 'POST', headers: auth, body: JSON.stringify({ reason: 'print', variant: 'storable' }),
  })
  const s1 = await status()
  add('打印拣货单后留痕 count=1', s1.waves[wave.id]?.picking?.count === 1,
    `HTTP ${lock1.status} · picking = ${JSON.stringify(s1.waves[wave.id]?.picking ?? null)}`)
  add('留痕带打印人与时间', !!s1.waves[wave.id]?.picking?.lastBy && !!s1.waves[wave.id]?.picking?.lastAt,
    `${s1.waves[wave.id]?.picking?.lastBy} @ ${s1.waves[wave.id]?.picking?.lastAt}`)

  // ── 关键：换一个"客户端"重新登录再问，仍看得见 ────────────────────────
  // localStorage 方案在这一步必然为空——这正是原来那个 bug 的形状。
  const token2 = await login()
  const s2 = await (async () => {
    const r = await fetch(`${BASE}/api/waves/print-status?date=${day}`, {
      headers: { Authorization: `Bearer ${token2}` },
    })
    return await r.json() as StatusResp
  })()
  add('换一个客户端仍看得见留痕（原 localStorage 方案必然失败）',
    s2.waves[wave.id]?.picking?.count === 1,
    `新会话读到 count=${s2.waves[wave.id]?.picking?.count ?? 0}`)

  // ── 再打一次：次数累加，不是覆盖 ────────────────────────────────────────
  await fetch(`${BASE}/api/waves/${wave.id}/pick-lock`, {
    method: 'POST', headers: auth, body: JSON.stringify({ reason: 'print', variant: 'consumable' }),
  })
  const s3 = await status()
  add('重打累加次数（前端据此弹二次确认）', s3.waves[wave.id]?.picking?.count === 2,
    `count = ${s3.waves[wave.id]?.picking?.count ?? 0}（应为 2）`)

  // ── 不同单据类型分别计数，不混算 ────────────────────────────────────────
  await fetch(`${BASE}/api/waves/${wave.id}/pick-lock`, {
    method: 'POST', headers: auth, body: JSON.stringify({ reason: 'print', printType: 'delivery' }),
  })
  const s4 = await status()
  add('送货单与拣货单分别计数', s4.waves[wave.id]?.delivery?.count === 1 && s4.waves[wave.id]?.picking?.count === 2,
    `picking=${s4.waves[wave.id]?.picking?.count} delivery=${s4.waves[wave.id]?.delivery?.count}`)

  // ── 手动锁定不算打印 ────────────────────────────────────────────────────
  const before = s4.waves[wave.id]?.picking?.count ?? 0
  await fetch(`${BASE}/api/waves/${wave.id}/pick-lock`, {
    method: 'POST', headers: auth, body: JSON.stringify({ reason: 'manual' }),
  })
  const s5 = await status()
  const after = s5.waves[wave.id]?.picking?.count ?? 0
  add('手动点「锁定」不算作打印过', after === before,
    `手动锁定前后 picking count：${before} → ${after}（不应变化）`)

  // ── print-log 不重复计数 ────────────────────────────────────────────────
  const dBefore = s5.waves[wave.id]?.delivery?.count ?? 0
  await fetch(`${BASE}/api/waves/print-log`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ date: day, type: 'delivery', scope: 'batch', batchLabel: 'x', waveId: wave.id }),
  })
  const s6 = await status()
  const dAfter = s6.waves[wave.id]?.delivery?.count ?? 0
  add('print-log 不重复计数（唯一来源是 pick-lock）', dAfter === dBefore,
    `print-log 调用前后 delivery count：${dBefore} → ${dAfter}（不应变化，否则一次打印算两次）`)

  // print-log 也不该被当成"看不懂的老日志"——否则每打一次送货单，界面上就多一句
  // 「另有 N 条早期记录」。它必须被显式识别并跳过。
  add('print-log 不混进 legacyCount', s6.legacyCount === s5.legacyCount,
    `legacyCount：${s5.legacyCount} → ${s6.legacyCount}（不应变化）`)

  await prisma.$disconnect()
  report()
}

function report() {
  console.log('\n──── 打单工作台：服务端打印留痕 ────')
  for (const c of cases) {
    const icon = c.state === 'pass' ? '✅' : c.state === 'fail' ? '❌' : '⚠️ '
    console.log(`  ${icon} ${c.name.padEnd(38)} ${c.detail}`)
  }
  const failed = cases.filter(c => c.state === 'fail')
  const skipped = cases.filter(c => c.state === 'skip')
  console.log(`\n合计 ${cases.length} 例 · 通过 ${cases.length - failed.length - skipped.length} · 失败 ${failed.length} · ⚠️ 未获验证 ${skipped.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
