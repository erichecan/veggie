/**
 * 删除 scripts/seed-purchases-inventory-demo.ts 生成的演示数据。
 * 读 scripts/.demo-seed-manifest.json，按 id 精确删除，不触碰 manifest 之外的任何真实数据。
 *
 * Product.qtyOnHand 按 manifest 记录的"增量"精确回滚（不是覆盖快照）——
 * 这期间如果这些商品发生过真实的收货/出库/报废，也不会被本脚本误删或覆盖。
 * Product.standardPrice（加权平均成本）不做回滚：属于滚动估算值，seed 期间的微小
 * 漂移影响很小，且无法在有并发真实交易的情况下被干净地精确逆算，保留即可。
 *
 * ProductSupplierInfo 和 CategoryGroup.ownerUserId 是永久配置，不在本脚本删除范围内。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/unseed-purchases-inventory-demo.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/unseed-purchases-inventory-demo.ts dotenv_config_path=.env.local --apply    # 真正删除
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'node:fs'
import path from 'node:path'

const prisma = createPrismaClient() as any
const APPLY = process.argv.includes('--apply')
const MANIFEST_PATH = path.join(__dirname, '.demo-seed-manifest.json')

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log(`找不到 ${MANIFEST_PATH}，没有可删除的演示数据（或已经删过了）。`)
    return
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
  console.log(`\n=== 删除演示数据 (${APPLY ? 'APPLY 真正删除' : 'DRY-RUN 只读'}) ===`)
  console.log(`manifest 生成于 ${manifest.createdAt}`)

  // 1) 按 delta 回滚 Product.qtyOnHand（先做这步，此时 StockMove/Lot 还没删，若中途失败可重跑）
  const deltas = manifest.productQtyDeltas as Record<string, number>
  console.log(`\n[1/8] 回滚 ${Object.keys(deltas).length} 个商品的库存增量`)
  for (const [productId, delta] of Object.entries(deltas)) {
    if (delta === 0) continue
    console.log(`  ${productId}: 回滚 delta=${delta}`)
    if (APPLY) {
      await prisma.product.update({ where: { id: productId }, data: { qtyOnHand: { decrement: delta } } })
    }
  }

  // 2) StockMove（先删，因为 Lot 被 StockMove.lotId 引用，Restrict 约束必须先清空引用方）
  console.log(`\n[2/8] 删除 ${manifest.stockMoveIds.length} 条库存流水`)
  if (APPLY && manifest.stockMoveIds.length) await prisma.stockMove.deleteMany({ where: { id: { in: manifest.stockMoveIds } } })

  // 3) GoodsReceipt
  console.log(`[3/8] 删除 ${manifest.goodsReceiptIds.length} 张收货单`)
  if (APPLY && manifest.goodsReceiptIds.length) await prisma.goodsReceipt.deleteMany({ where: { id: { in: manifest.goodsReceiptIds } } })

  // 4) Lot
  console.log(`[4/8] 删除 ${manifest.lotIds.length} 个批次`)
  if (APPLY && manifest.lotIds.length) await prisma.lot.deleteMany({ where: { id: { in: manifest.lotIds } } })

  // 5) VendorBill（必须在删 PurchaseOrder 之前，VendorBill.purchaseOrderId 无级联）
  console.log(`[5/8] 删除 ${manifest.vendorBillIds.length} 张供应商账单`)
  if (APPLY && manifest.vendorBillIds.length) await prisma.vendorBill.deleteMany({ where: { id: { in: manifest.vendorBillIds } } })

  // 6) PurchaseOrder（级联删除其 PurchaseOrderLine / GoodsReceipt 关系，但 GoodsReceipt 已在上面单独删过）
  console.log(`[6/8] 删除 ${manifest.purchaseOrderIds.length} 张采购单`)
  if (APPLY && manifest.purchaseOrderIds.length) await prisma.purchaseOrder.deleteMany({ where: { id: { in: manifest.purchaseOrderIds } } })

  // 7) PurchaseSuggestion + StockTake（级联删除 StockTakeLine）
  console.log(`[7/8] 删除 ${manifest.purchaseSuggestionIds.length} 条采购建议 + ${manifest.stockTakeIds.length} 张盘点单`)
  if (APPLY) {
    if (manifest.purchaseSuggestionIds.length) await prisma.purchaseSuggestion.deleteMany({ where: { id: { in: manifest.purchaseSuggestionIds } } })
    if (manifest.stockTakeIds.length) await prisma.stockTake.deleteMany({ where: { id: { in: manifest.stockTakeIds } } })
  }

  // 8) ActionLog
  console.log(`[8/8] 删除 ${manifest.actionLogIds.length} 条操作日志`)
  if (APPLY && manifest.actionLogIds.length) await prisma.actionLog.deleteMany({ where: { id: { in: manifest.actionLogIds } } })

  if (APPLY) {
    fs.unlinkSync(MANIFEST_PATH)
    console.log('\n已删除全部演示数据，manifest 文件已清理。')
    console.log('注：ProductSupplierInfo（商品供应商进价）和 CategoryGroup 负责人是永久配置，未删除。')
  } else {
    console.log('\n这是 dry-run，未删除任何数据。加 --apply 才会真正删除。')
  }
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
