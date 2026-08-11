/**
 * 给测试库铺库存底数（期初余额口径）
 * ============================================================================
 * 台账 Z5。落的是 20260811 拍板的决策：**不补历史出入库流水**，起算日之前的
 * 存量一律作期初余额记一笔 ADJUSTMENT，起算日之后严格走流水。
 *
 * 为什么需要它：CSV 导出在 20260715 换格式后不再带库存列，重建的测试库里
 * 1548 个商品一条流水都没有。零库存下 A3 下单 / D6 缺货 / I3 单位换算 这几条
 * 测试全会被判缺货 —— 得到的不是「测出问题」，而是「测不出东西」。
 *
 * ⛔ 只允许打向本机测试库。给生产库凭空补库存是灾难性的。
 *
 * 用法：
 *   npx tsx --env-file=.env.test scripts/seed/ensure-opening-stock.ts
 *   npx tsx --env-file=.env.test scripts/seed/ensure-opening-stock.ts --target 100
 *   npx tsx --env-file=.env.test scripts/seed/ensure-opening-stock.ts --products p123,p456
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { ensureOpeningStock } from '../../prisma/seed-events/inventory'

/**
 * 起算日。取切换到自有服务器那天（20260805）—— 在此之前的库存是搬迁过来的
 * 存量，本就没有可信的流水可追溯；在此之后的一切都应该有流水。
 * 客户若指定了实际启用日，改这里即可。
 */
const OPENING_DATE = new Date('2026-08-05T00:00:00Z')
const DEFAULT_TARGET = 60

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL 未设置。用 --env-file 指定环境文件。')
    process.exit(1)
  }
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 目标库不是本机地址。本脚本会写入库存流水，只允许打向本地测试库。')
    console.error(`   当前指向：${url.replace(/:\/\/[^@]*@/, '://***@')}`)
    process.exit(1)
  }

  const target = Number(arg('target') ?? DEFAULT_TARGET)
  if (!Number.isFinite(target) || target <= 0) {
    console.error(`--target 必须是正数，收到 "${arg('target')}"`)
    process.exit(1)
  }
  const productIds = arg('products')?.split(',').map(s => s.trim()).filter(Boolean)

  const prisma = createPrismaClient()
  try {
    const before = await prisma.product.count({ where: { qtyOnHand: { gt: 0 } } })
    const touched = await ensureOpeningStock(prisma, {
      target,
      backdate: OPENING_DATE,
      productIds,
    })
    const after = await prisma.product.count({ where: { qtyOnHand: { gt: 0 } } })

    console.log(`起算日      ${OPENING_DATE.toISOString().slice(0, 10)}`)
    console.log(`目标库存    ${target}`)
    console.log(`补足商品    ${touched} 个`)
    console.log(`有库存商品  ${before} → ${after}`)
    console.log('\n下一步：npx tsx --env-file=.env.test scripts/validate-data.ts 确认守恒仍成立')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
