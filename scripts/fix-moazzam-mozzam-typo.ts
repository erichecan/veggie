/**
 * 订正脚本：司机「Moazzam」的 DriverSlot/PickingWave 存在拼写错误的重复记录「Mozzam」
 *
 * 背景：User.name = "Moazzam"(role=DRIVER)，但 DriverSlot 表里有两条同一 userId 的记录
 * 被手滑打成了 "Mozzam"（pm/3、pm/4），导致：
 *   1) 批次管理页司机筛选栏按 driverName 字符串去重，同一个人显示成两个 chip
 *   2) 2026-07-03 pm 这个真实车次被拆成两条 PickingWave："…#25 Moazzam"(6单) 和
 *      "…#26 Mozzam"(5单)，本该是同一趟车
 *
 * 修复内容：
 *   1. 把 "Mozzam" pm/3 波次(cmri9al4q...)里的 5 个真实订单，通过 assignOrderToWave 重新分配到
 *      正确的 "Moazzam" pm/3 DriverSlot(cmri9a6nq...)，函数内部会自动把订单从旧波次摘除、
 *      合并进已存在的 "Moazzam" pm/3 波次(cmri97jfx...)，并同步 Pallet
 *   2. 删除所有 driverName="Mozzam" 的空 PickingWave(合并后应全部为空，级联删除其 Pallet)
 *   3. 归档两条拼写为 "Mozzam" 的 DriverSlot(pm/3、pm/4)——归档即从司机筛选栏/托盘配置里消失，
 *      归档前会先跑一遍其托盘清理(此时应已无订单，是空操作)
 *
 * 所有涉及订单 status 均为 WAVE_ASSIGNED、driverSlotId=null、commissionFrozenAt=null，
 * 未出发未锁定，操作安全、可逆(归档可通过 driver-slots POST 撞名复活)。
 *
 * 用法：
 *   npx tsx --env-file=.env.local scripts/fix-moazzam-mozzam-typo.ts            # dry-run，只读
 *   npx tsx --env-file=.env.local scripts/fix-moazzam-mozzam-typo.ts --apply    # 实际写库
 */
import { prisma } from '../lib/db'
import { assignOrderToWave, deletePalletForDriverSlot } from '../lib/wave-assign'

const APPLY = process.argv.includes('--apply')

const MOAZZAM_PM3_SLOT_ID = 'cmri9a6nq003i01s68j0x74rx' // 正确拼写、在用的 pm/3 DriverSlot
const MOZZAM_SLOT_IDS = ['cmq4iyj9h000136ylwwr78cjg', 'cmri9k9kt004001s6o1x4kfxj'] // 拼写错误的两条

async function main() {
  console.log(`\n=== 司机 Moazzam/Mozzam 拼写重复订正 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const mozzamWaves = await prisma.pickingWave.findMany({
    where: { driverName: 'Mozzam' },
    select: { id: true, name: true, orderIds: true },
  })
  const waveWithOrders = mozzamWaves.filter(w => w.orderIds.length > 0)
  const emptyWaves = mozzamWaves.filter(w => w.orderIds.length === 0)

  console.log(`发现 "Mozzam" 波次 ${mozzamWaves.length} 条：${waveWithOrders.length} 条有真实订单，${emptyWaves.length} 条空`)
  for (const w of waveWithOrders) console.log(`  - ${w.name}  ${w.orderIds.length} 单：${w.orderIds.join(', ')}`)

  const targetSlot = await prisma.driverSlot.findUnique({ where: { id: MOAZZAM_PM3_SLOT_ID } })
  if (!targetSlot || targetSlot.driverName !== 'Moazzam' || targetSlot.archived) {
    throw new Error(`目标 DriverSlot ${MOAZZAM_PM3_SLOT_ID} 状态异常，请重新核对后再跑脚本`)
  }
  console.log(`\n合并目标 DriverSlot：${targetSlot.driverName} ${targetSlot.timeOfDay}/${targetSlot.batchNum}（${targetSlot.id}）\n`)

  if (!APPLY) {
    console.log('DRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
    return
  }

  // 1) 把有真实订单的 Mozzam 波次，逐单重新分配到正确的 Moazzam pm/3 slot(自动合并进已有波次)
  for (const w of waveWithOrders) {
    for (const orderId of w.orderIds) {
      const result = await assignOrderToWave(orderId, MOAZZAM_PM3_SLOT_ID)
      console.log(`  订单 ${orderId} → 波次 ${result?.waveId}（${result?.driverName}）`)
    }
  }

  // 2) 删除所有 "Mozzam" 波次(此时应已全部清空，级联删除其 Pallet)
  const stillNonEmpty = await prisma.pickingWave.findMany({
    where: { driverName: 'Mozzam', orderIds: { isEmpty: false } },
  })
  if (stillNonEmpty.length > 0) {
    throw new Error(`仍有 ${stillNonEmpty.length} 条 Mozzam 波次非空，未按预期清空，请检查后再删除`)
  }
  const del = await prisma.pickingWave.deleteMany({ where: { driverName: 'Mozzam' } })
  console.log(`\n已删除空的 "Mozzam" 波次 ${del.count} 条`)

  // 3) 归档两条拼写错误的 DriverSlot(先跑联动清理，此时应为空操作)
  for (const id of MOZZAM_SLOT_IDS) {
    const slot = await prisma.driverSlot.findUnique({ where: { id } })
    if (!slot) { console.log(`  DriverSlot ${id} 不存在，跳过`); continue }
    const { unassignedOrderCount } = await deletePalletForDriverSlot(slot)
    await prisma.driverSlot.update({ where: { id }, data: { archived: true } })
    console.log(`  已归档 DriverSlot "${slot.driverName}" ${slot.timeOfDay}/${slot.batchNum}（退回待分配 ${unassignedOrderCount} 单，预期为 0）`)
  }

  console.log('\n订正完成。\n')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
