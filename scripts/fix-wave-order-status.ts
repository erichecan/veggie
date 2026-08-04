/**
 * 订正脚本：Order.status 与 wave.orderIds 归属一致性（SSOT = wave.orderIds）
 *
 * 背景：历史上「拖拽分配」只改 wave.orderIds，不回写 Order.status，导致存量数据里
 *   - 订单已在某波次(orderIds)里，但 status 仍是 CONFIRMED（销售单列表仍显示为待分配）
 *   - 或订单 status=WAVE_ASSIGNED，却不在任何波次里（孤儿状态）
 * 代码侧已修复（assign/unassign/POST 原子回写），本脚本一次性订正存量脏数据。
 *
 * 不变量（目标）：status==CONFIRMED  ⇔  不在任何 wave.orderIds
 *   仅在 CONFIRMED ↔ WAVE_ASSIGNED 之间订正；IN_DELIVERY / COMPLETED / PENDING 一律不动。
 *
 * 幂等、确定性。用法：
 *   node --import tsx -r dotenv/config scripts/fix-wave-order-status.ts dotenv_config_path=.env.local           # dry-run（只读统计，绝不写库）
 *   node --import tsx -r dotenv/config scripts/fix-wave-order-status.ts dotenv_config_path=.env.local --apply   # 事务写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const sample = (arr: string[], n = 15) => arr.slice(0, n).join(', ') + (arr.length > n ? ` …(+${arr.length - n})` : '')

async function main() {
  console.log(`\n=== Wave↔Order 状态一致性订正 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  // 1) 收集所有「已在某波次」的订单 ID（union）
  const waves = await prisma.pickingWave.findMany({ select: { id: true, orderIds: true } })
  const assigned = new Set<string>()
  for (const w of waves) for (const oid of (w.orderIds as string[])) assigned.add(oid)
  console.log(`波次 ${waves.length} 个，去重后已分配订单 ${assigned.size} 个\n`)

  // 2) 拉取所有订单当前状态
  const orders = await prisma.order.findMany({ select: { id: true, code: true, status: true } })
  console.log(`订单总数 ${orders.length}\n`)

  // 3) 计算两类需订正的订单
  //    Fix1: 在某波次里 且 status=CONFIRMED  → 应为 WAVE_ASSIGNED
  //    Fix2: status=WAVE_ASSIGNED 且 不在任何波次 → 应退回 CONFIRMED（孤儿）
  const toAssign: { id: string; code: string }[] = []
  const toConfirm: { id: string; code: string }[] = []
  // 顺带统计：在波次里但已出发/完成（正常，不订正，仅报告）
  let inWaveButDispatched = 0
  for (const o of orders) {
    const inWave = assigned.has(o.id)
    const s = String(o.status).toUpperCase()
    if (inWave && s === 'CONFIRMED') toAssign.push({ id: o.id, code: o.code ?? o.id })
    else if (!inWave && s === 'WAVE_ASSIGNED') toConfirm.push({ id: o.id, code: o.code ?? o.id })
    else if (inWave && (s === 'IN_DELIVERY' || s === 'COMPLETED')) inWaveButDispatched++
  }

  console.log(`【Fix1】在波次里但 status=CONFIRMED（应升级 WAVE_ASSIGNED）：${toAssign.length} 个`)
  if (toAssign.length) console.log(`        ${sample(toAssign.map(x => x.code))}`)
  console.log(`【Fix2】status=WAVE_ASSIGNED 但不在任何波次（应退回 CONFIRMED）：${toConfirm.length} 个`)
  if (toConfirm.length) console.log(`        ${sample(toConfirm.map(x => x.code))}`)
  console.log(`【正常】在波次里且已出发/完成（不订正）：${inWaveButDispatched} 个\n`)

  if (!APPLY) {
    console.log('DRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
    return
  }

  if (toAssign.length === 0 && toConfirm.length === 0) {
    console.log('无需订正，数据已一致。\n')
    return
  }

  await prisma.$transaction(async (tx) => {
    if (toAssign.length) {
      const r = await tx.order.updateMany({
        where: { id: { in: toAssign.map(x => x.id) }, status: 'CONFIRMED' },
        data: { status: 'WAVE_ASSIGNED' },
      })
      console.log(`Fix1 已更新 ${r.count} 个 → WAVE_ASSIGNED`)
    }
    if (toConfirm.length) {
      const r = await tx.order.updateMany({
        where: { id: { in: toConfirm.map(x => x.id) }, status: 'WAVE_ASSIGNED' },
        data: { status: 'CONFIRMED' },
      })
      console.log(`Fix2 已更新 ${r.count} 个 → CONFIRMED`)
    }
  })
  console.log('\n订正完成（事务提交）。\n')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
