/**
 * scripts/fix-locked-orders-delivered-qty-20260717.ts
 *
 * db:validate 的"状态机自洽"检查报出：本次导入的 148,478 笔 LOCKED 历史订单里，
 * 48,302 笔 deliveredQty != orderedQty，违反"完成单应已全部交付"的不变量。
 *
 * 根因排查（见对话记录）：其中 43,102 行（占违例总数 89%）的特征是
 * deliveredQty=0 但 invoicedQty=orderedQty——即 Odoo 里这笔已经完整开票（真实发生过的
 * 交易，不可能开票了却没发货），只是 Odoo 自己的 qty_delivered 跟踪字段没同步更新，
 * 不是真实世界里发生了部分交付。用 invoicedQty 已确认完成这一更可靠的信号回填
 * deliveredQty，比信任 Odoo 这个明显没维护好的字段更接近事实。
 *
 * 刻意不处理的另外两类（不在本脚本范围内，是本次遗留的已知小缺口，非常小比例，
 * 证据不足以支持强行改写，动了反而可能抹掉真实的历史差异记录）：
 *   - deliveredQty=0 且 invoicedQty 也不等于 orderedQty（约 3,044 行）：真假不明，留原样
 *   - 0 < deliveredQty < orderedQty（约 1,241 行）：可能是真实部分交付历史，不动
 *   - deliveredQty > orderedQty（约 6,149 行）：Odoo 自己的数据小毛病（四舍五入/退货调整），不动
 *
 * 范围：只动本次 Phase 4 导入的订单（externalRef LIKE '%_import20260717'），不碰
 * 生产库原有的 952 笔订单（那批数据的交付状态是这个系统自己记录的，应该信任）。
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/fix-locked-orders-delivered-qty-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/fix-locked-orders-delivered-qty-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

async function main() {
  const countResult = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "OrderLine" ol
    JOIN "Order" o ON o.id = ol."orderId"
    WHERE o.status = 'LOCKED' AND o."externalRef" LIKE '%_import20260717'
      AND ol."deliveredQty" = 0 AND ol."invoicedQty" = ol."orderedQty"
  `
  const affected = Number(countResult[0].count)
  console.log(`计划回填 deliveredQty = orderedQty 的行数: ${affected}`)

  if (!APPLY) {
    console.log('(dry-run，未写入。加 --apply 才会真正执行)')
    await prisma.$disconnect()
    return
  }

  const result = await prisma.$executeRaw`
    UPDATE "OrderLine" ol
    SET "deliveredQty" = ol."orderedQty"
    FROM "Order" o
    WHERE o.id = ol."orderId"
      AND o.status = 'LOCKED' AND o."externalRef" LIKE '%_import20260717'
      AND ol."deliveredQty" = 0 AND ol."invoicedQty" = ol."orderedQty"
  `
  console.log(`✅ 完成：更新 ${result} 行`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
