/**
 * 只读诊断：找出「订单在某波次的 orderIds 里，但 Order.deliveryDate ≠ 该波次 waveDate」的错配。
 * 这正是销售单列表(按 deliveryDate)与配送中心(按 wave.orderIds)计数对不上的根因。
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-wave-deliverydate.ts          # 全库
 *   npx tsx --env-file=.env.local scripts/diagnose-wave-deliverydate.ts --fix    # 回写 deliveryDate=waveDate
 *
 * 默认只读、不改任何数据。加 --fix 才会把错配订单的 deliveryDate 回写为其波次的 waveDate
 * (仅限 status ∈ {CONFIRMED, WAVE_ASSIGNED} 的未出发订单；已出发/完成的不动)，并同步 deliverySlip。
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const DO_FIX = process.argv.includes('--fix')
const ymd = (d: Date | null | undefined): string => (d ? new Date(d).toISOString().slice(0, 10) : 'NULL')

async function main(): Promise<void> {
  console.log(`🔎 波次成员 ↔ 订单 deliveryDate 一致性诊断（${DO_FIX ? '修复模式 --fix' : '只读'}）\n`)

  // 所有有 waveDate 的波次（含已出发的，用于判断一个订单是否被多个波次引用）
  const waves = await prisma.pickingWave.findMany({
    where: { waveDate: { not: null } },
    select: { id: true, name: true, waveDate: true, orderIds: true, dispatchedAt: true },
  })

  // 建 orderId → [{waveId, waveDate, dispatched}] 映射，检测多波次引用的歧义
  const membership = new Map<string, { waveId: string; waveName: string | null; waveDate: Date; dispatched: boolean }[]>()
  for (const w of waves) {
    if (!w.waveDate) continue
    for (const oid of (w.orderIds as string[])) {
      const arr = membership.get(oid) ?? []
      arr.push({ waveId: w.id, waveName: w.name, waveDate: w.waveDate, dispatched: !!w.dispatchedAt })
      membership.set(oid, arr)
    }
  }

  const orderIds = [...membership.keys()]
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, code: true, status: true, deliveryDate: true, restaurantName: true },
  })
  const orderMap = new Map(orders.map(o => [o.id, o]))

  const mismatches: { code: string; id: string; status: string; orderDD: string; waveDate: string; waveName: string | null; dispatched: boolean }[] = []
  const ambiguous: { id: string; waves: string[] }[] = []

  for (const [oid, mem] of membership) {
    const o = orderMap.get(oid)
    if (!o) continue
    const activeWaves = mem // 一个订单理应只在一个波次;若多于一个则歧义
    if (activeWaves.length > 1) {
      ambiguous.push({ id: oid, waves: activeWaves.map(m => `${m.waveName}(${ymd(m.waveDate)})`) })
    }
    // 用其(去重后)波次日期判断错配;取第一个波次为准
    const w = activeWaves[0]
    const odd = ymd(o.deliveryDate)
    const wdd = ymd(w.waveDate)
    if (odd !== wdd) {
      mismatches.push({ code: o.code ?? o.id, id: o.id, status: o.status, orderDD: odd, waveDate: wdd, waveName: w.waveName, dispatched: w.dispatched })
    }
  }

  console.log(`波次总数(有 waveDate): ${waves.length}｜被波次引用的订单: ${orderIds.length}`)
  console.log(`❗ deliveryDate ≠ waveDate 的错配订单: ${mismatches.length}`)
  if (ambiguous.length) console.log(`⚠️  同时被多个波次引用(歧义,--fix 会跳过): ${ambiguous.length}`)
  console.log()

  // 按 waveDate 分组打印
  const byDate = new Map<string, typeof mismatches>()
  for (const m of mismatches) {
    const arr = byDate.get(m.waveDate) ?? []
    arr.push(m); byDate.set(m.waveDate, arr)
  }
  for (const [d, list] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  波次日 ${d}（${list.length} 单）:`)
    for (const m of list) {
      console.log(`    ${m.code}  状态=${m.status}  订单deliveryDate=${m.orderDD}  波次=${m.waveName}${m.dispatched ? ' [已出发]' : ''}`)
    }
  }

  const ambiguousIds = new Set(ambiguous.map(a => a.id))
  const fixable = mismatches.filter(m => (m.status === 'CONFIRMED' || m.status === 'WAVE_ASSIGNED') && !ambiguousIds.has(m.id))
  const skipped = mismatches.length - fixable.length
  console.log(`\n可修复(未出发 CONFIRMED/WAVE_ASSIGNED 且不歧义): ${fixable.length}｜跳过(已出发/歧义): ${skipped}`)

  if (!DO_FIX) {
    console.log('\n只读模式，未改动任何数据。确认无误后加 --fix 执行回写。')
    await prisma.$disconnect()
    return
  }

  // --fix：逐单把 deliveryDate 回写为其波次 waveDate，并同步 deliverySlip
  let fixed = 0
  for (const m of fixable) {
    const w = membership.get(m.id)![0]
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: m.id }, data: { deliveryDate: w.waveDate } })
      await tx.deliverySlip.updateMany({ where: { orderId: m.id }, data: { deliveryDate: w.waveDate } })
    })
    fixed++
  }
  console.log(`\n✅ 已回写 ${fixed} 单的 deliveryDate=波次日。`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
