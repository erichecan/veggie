/**
 * 一次性订正脚本：修复 2026-09-05 当天两笔真实生产事故
 *
 * 事故1（孤儿单）：MJ-260905-002（€18.14，ANDRIUS 上午波次）编辑降级为 PENDING 时触发
 *   removeOrderFromAllWaves，orderIds 事务先提交、Pallet.items 清理是事务外的后续步骤且被
 *   静默吞掉（app/api/orders/[id]/route.ts 的 catch 只 console.error）。之后订单被重新确认
 *   并再次"分配订单 MJ-260905-002 到批次 ANDRIUS"（15:27:53，调度员最终意图很明确），但没能
 *   再回到 wave.orderIds——状态是 WAVE_ASSIGNED，却不属于任何波次，行数据仍卡在 Pallet.items 里。
 *
 * 事故2（重复波次）：assignOrderToWave 的"查有没有波次→没有就建"两步没有锁保护，
 *   16:38:54.669 / .671 两次几乎同时的分配请求都建了一条「2026-09-05 #3 YANG」，
 *   一条挂 MJ-260905-011，另一条挂 MJ-260905-010 并已被锁定/打印。
 *   `.find()`口径的界面只看得到先建的那条，MJ-260905-011 从司机卡片/打印中心里"消失"。
 *
 * 目标（幂等，可重复跑，dry-run 默认不写库）：
 *   1) 把 MJ-260905-002 合并回 ANDRIUS 波次的 orderIds，重建 zones（Pallet.items 已经有它，不用动）
 *   2) 把 MJ-260905-011 的订单行合并进 YANG 真实波次(已锁定/已打印那条)的托盘，
 *      orderIds 加入该订单，重建 zones；随后删除多余的重复波次+其托盘
 *
 * ⚠️ 两条波次此前都已锁定/标记"已打印"——本脚本只订正数据库归属，不代表仓库已经实际拣了
 * 这两单的货。跑完后必须让调度/打印员人工核实这两单当天是否真的被拣货装车，需要的话重打拣货单。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/fix-orphan-and-duplicate-wave-20260906.ts dotenv_config_path=.env.local           # dry-run
 *   node --import tsx -r dotenv/config scripts/fix-orphan-and-duplicate-wave-20260906.ts dotenv_config_path=.env.local --apply   # 事务写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
import { buildZonesByRestaurant } from '@/lib/wave-zones'

const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

const ORPHAN_ORDER_ID = 'cmtnqr5y4000t01pzulveyynf' // MJ-260905-002
const ANDRIUS_WAVE_ID = 'cmtoj41wc000k01qq6jvwty6t' // 2026-09-05 #1 ANDRIUS

const DUP_ORDER_ID = 'cmtolq75x002s01qq5r86weav' // MJ-260905-011
const DUP_WAVE_ID = 'cmtolxsip003v01qq15zoq39u' // 2026-09-05 #3 YANG（多建的那条，未锁定）
const REAL_WAVE_ID = 'cmtolxsiq003w01qqbz3y6cqz' // 2026-09-05 #3 YANG（已锁定/打印，真正在用的那条）

type PalletItem = {
  orderId: string; orderCode?: string; restaurantId: string; restaurantName: string
  productId: string; productName: string; qty: number; uomName?: string
}

async function main() {
  console.log(`\n=== 订正孤儿单 + 重复波次 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  // ---------- 事故1：孤儿单 MJ-260905-002 ----------
  const order002 = await prisma.order.findUnique({ where: { id: ORPHAN_ORDER_ID } })
  const andriusWave = await prisma.pickingWave.findUnique({ where: { id: ANDRIUS_WAVE_ID } })
  if (!order002 || !andriusWave) throw new Error('孤儿单或 ANDRIUS 波次不存在，脚本假设已失效，请先核对')

  const alreadyInAndrius = (andriusWave.orderIds as string[]).includes(ORPHAN_ORDER_ID)
  console.log(`[孤儿单] ${order002.code} status=${order002.status} 当前是否已在 ANDRIUS 波次 orderIds 中: ${alreadyInAndrius}`)
  if (order002.status !== 'WAVE_ASSIGNED') {
    console.log(`  ⚠️ 订单状态已不是 WAVE_ASSIGNED(现为 ${order002.status})，可能已被人工处理过，跳过此项修复`)
  }

  // ---------- 事故2：重复波次 ----------
  const dupWave = await prisma.pickingWave.findUnique({ where: { id: DUP_WAVE_ID }, include: { pallets: true } })
  const realWave = await prisma.pickingWave.findUnique({ where: { id: REAL_WAVE_ID }, include: { pallets: true } })
  if (!dupWave || !realWave) throw new Error('重复波次之一已不存在，脚本假设已失效，请先核对')

  const dupHasOrder = (dupWave.orderIds as string[]).includes(DUP_ORDER_ID)
  const realHasOrder = (realWave.orderIds as string[]).includes(DUP_ORDER_ID)
  console.log(`[重复波次] MJ-260905-011 在多余波次(${DUP_WAVE_ID})中: ${dupHasOrder}，在真实波次(${REAL_WAVE_ID})中: ${realHasOrder}`)

  if (!APPLY) {
    console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
    return
  }

  // ---------- 写库：事故1 ----------
  if (!alreadyInAndrius && order002.status === 'WAVE_ASSIGNED') {
    const merged = Array.from(new Set([...(andriusWave.orderIds as string[]), ORPHAN_ORDER_ID]))
    const zones = await buildZonesByRestaurant(merged)
    await prisma.pickingWave.update({
      where: { id: ANDRIUS_WAVE_ID },
      data: { orderIds: merged, zones, assignmentDoneAt: null },
    })
    console.log(`✅ [孤儿单] 已把 ${order002.code} 合并回 ANDRIUS 波次 orderIds，assignmentDoneAt 已清空待复核`)
  } else {
    console.log('⏭️  [孤儿单] 无需处理（已一致或状态已变化）')
  }

  // ---------- 写库：事故2 ----------
  if (dupHasOrder && !realHasOrder) {
    const dupPallet = dupWave.pallets.find(p => (p.items as PalletItem[]).some(it => it.orderId === DUP_ORDER_ID))
    const realPallet = realWave.pallets[0] // 已确认真实波次目前只有 seq=1 一个托盘
    if (!dupPallet || !realPallet) throw new Error('托盘结构与预期不符，中止')

    const movingItems = (dupPallet.items as PalletItem[]).filter(it => it.orderId === DUP_ORDER_ID)
    const mergedItems = [...(realPallet.items as PalletItem[]), ...movingItems]
    const mergedOrderIds = Array.from(new Set([...(realWave.orderIds as string[]), DUP_ORDER_ID]))
    const zones = await buildZonesByRestaurant(mergedOrderIds)

    await prisma.$transaction([
      prisma.pallet.update({ where: { id: realPallet.id }, data: { items: mergedItems } }),
      prisma.pickingWave.update({
        where: { id: REAL_WAVE_ID },
        data: { orderIds: mergedOrderIds, zones, assignmentDoneAt: null },
      }),
      prisma.pallet.delete({ where: { id: dupPallet.id } }),
      prisma.pickingWave.delete({ where: { id: DUP_WAVE_ID } }),
    ])
    console.log(`✅ [重复波次] 已把 MJ-260905-011 合并进真实波次 ${REAL_WAVE_ID}，删除多余波次 ${DUP_WAVE_ID}`)
  } else {
    console.log('⏭️  [重复波次] 无需处理（已一致或状态已变化）')
  }

  console.log('\n订正完成。⚠️ 请通知调度/打印员人工核实这两单今天是否已随车实际拣货装车，需要的话重打拣货单。\n')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
